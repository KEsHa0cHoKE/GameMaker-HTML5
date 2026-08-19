// Experimental Musical Tiles particle runtime patch.
//
// Goal:
//   * stop runtime-created particle type IDs from growing forever when their
//     types are destroyed frequently (Musical Tiles creates one type per burst);
//   * keep the experiment isolated from ACTUAL-RUNTIME until it is validated;
//   * expose exact particle runtime counters for browser-side profiling.
//
// Important: a destroyed particle type ID must not be reused while any live
// particle/emitter still references that numeric ID. The stock HTML5 runtime
// stores only the numeric parttype on particles, so blindly filling every null
// slot can make an old particle resolve to a completely different new type.
(function () {
    "use strict";

    if (typeof ParticleType_Create !== "function" ||
        typeof ParticleType_Destroy !== "function" ||
        typeof ParticleSystem_Destroy !== "function" ||
        typeof yyParticleType !== "function") {
        if (typeof console !== "undefined" && console.warn) {
            console.warn("[MT particle experiment] particle runtime symbols are unavailable");
        }
        return;
    }

    var originalParticleTypeCreate = ParticleType_Create;
    var originalParticleTypeDestroy = ParticleType_Destroy;
    var originalParticleTypeDestroyAll = (typeof ParticleType_DestroyAll === "function")
        ? ParticleType_DestroyAll
        : null;
    var originalParticleSystemDestroy = ParticleSystem_Destroy;

    var freeTypeIds = [];
    var freeTypeIdSet = Object.create(null);
    var pendingTypeIds = [];
    var pendingTypeIdSet = Object.create(null);

    var stats = {
        createdFresh: 0,
        reused: 0,
        destroyed: 0,
        destroyBlockedByLiveReference: 0,
        reclaimedAfterSystemDestroy: 0
    };

    function particleTypeIdIsReferenced(id) {
        if (typeof g_ParticleSystemManager === "undefined" || !g_ParticleSystemManager) {
            return false;
        }

        var systemCount = g_ParticleSystemManager.Count();
        for (var s = 0; s < systemCount; ++s) {
            var system = g_ParticleSystemManager.At(s);
            if (system == null || !system.emitters) {
                continue;
            }

            for (var e = 0; e < system.emitters.length; ++e) {
                var emitter = system.emitters[e];
                if (emitter == null) {
                    continue;
                }

                // Streaming emitters retain their source type separately from
                // the individual particles, so treat an active emitter as a ref.
                if (emitter.parttype === id &&
                    (emitter.created || emitter.zombie ||
                     (emitter.particles && emitter.particles.length > 0))) {
                    return true;
                }

                var particles = emitter.particles;
                if (!particles) {
                    continue;
                }

                for (var p = 0; p < particles.length; ++p) {
                    var particle = particles[p];
                    if (particle != null && particle.parttype === id) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    function enqueueFreeTypeId(id) {
        if (freeTypeIdSet[id]) {
            return;
        }

        freeTypeIdSet[id] = true;
        freeTypeIds.push(id);
    }

    function enqueuePendingTypeId(id) {
        if (pendingTypeIdSet[id]) {
            return;
        }

        pendingTypeIdSet[id] = true;
        pendingTypeIds.push(id);
    }

    function reclaimPendingTypeIds() {
        if (pendingTypeIds.length === 0) {
            return;
        }

        var stillPending = [];
        var stillPendingSet = Object.create(null);

        for (var i = 0; i < pendingTypeIds.length; ++i) {
            var id = pendingTypeIds[i];

            if (typeof g_ParticleTypes === "undefined" || g_ParticleTypes[id] != null) {
                // The slot is no longer a destroyed hole. Drop stale bookkeeping.
                continue;
            }

            if (!particleTypeIdIsReferenced(id)) {
                enqueueFreeTypeId(id);
                stats.reclaimedAfterSystemDestroy++;
                continue;
            }

            stillPending.push(id);
            stillPendingSet[id] = true;
        }

        pendingTypeIds = stillPending;
        pendingTypeIdSet = stillPendingSet;
    }

    ParticleType_Create = function () {
        // Prefer an explicitly proven-safe destroyed slot. Recheck the slot at
        // the last moment because the stock runtime has no generation counter.
        while (freeTypeIds.length > 0) {
            var id = freeTypeIds.pop();
            delete freeTypeIdSet[id];

            if (typeof g_ParticleTypes !== "undefined" &&
                g_ParticleTypes[id] == null &&
                !particleTypeIdIsReferenced(id)) {
                g_ParticleTypes[id] = new yyParticleType();
                stats.reused++;
                return id;
            }
        }

        stats.createdFresh++;
        return originalParticleTypeCreate.apply(this, arguments);
    };

    ParticleType_Destroy = function (_ind) {
        var id = yyGetInt32(_ind);
        var result = originalParticleTypeDestroy.apply(this, arguments);

        if (result === true) {
            stats.destroyed++;

            if (particleTypeIdIsReferenced(id)) {
                // This commonly happens when user code destroys the type before
                // destroying its particle system. Defer reuse until the system
                // has gone away instead of changing live-particle semantics.
                stats.destroyBlockedByLiveReference++;
                enqueuePendingTypeId(id);
            } else {
                enqueueFreeTypeId(id);
            }
        }

        return result;
    };

    ParticleSystem_Destroy = function () {
        var result = originalParticleSystemDestroy.apply(this, arguments);
        reclaimPendingTypeIds();
        return result;
    };

    if (originalParticleTypeDestroyAll) {
        ParticleType_DestroyAll = function () {
            freeTypeIds = [];
            freeTypeIdSet = Object.create(null);
            pendingTypeIds = [];
            pendingTypeIdSet = Object.create(null);
            return originalParticleTypeDestroyAll.apply(this, arguments);
        };
    }

    function getSnapshot() {
        var registryLength = 0;
        var liveTypes = 0;
        var liveSystems = 0;
        var liveEmitters = 0;
        var liveParticles = 0;

        if (typeof g_ParticleTypes !== "undefined" && g_ParticleTypes) {
            registryLength = g_ParticleTypes.length;
            for (var t = 0; t < registryLength; ++t) {
                if (g_ParticleTypes[t] != null) {
                    liveTypes++;
                }
            }
        }

        if (typeof g_ParticleSystemManager !== "undefined" && g_ParticleSystemManager) {
            var systemCount = g_ParticleSystemManager.Count();
            for (var s = 0; s < systemCount; ++s) {
                var system = g_ParticleSystemManager.At(s);
                if (system == null) {
                    continue;
                }

                liveSystems++;

                if (!system.emitters) {
                    continue;
                }

                for (var e = 0; e < system.emitters.length; ++e) {
                    var emitter = system.emitters[e];
                    if (emitter == null) {
                        continue;
                    }

                    if (emitter.created || emitter.zombie ||
                        (emitter.particles && emitter.particles.length > 0)) {
                        liveEmitters++;
                    }

                    if (emitter.particles) {
                        liveParticles += emitter.particles.length;
                    }
                }
            }
        }

        return {
            typeRegistryLength: registryLength,
            liveTypes: liveTypes,
            typeRegistryHoles: registryLength - liveTypes,
            reusableTypeIds: freeTypeIds.length,
            pendingTypeIds: pendingTypeIds.length,
            liveSystems: liveSystems,
            liveEmitters: liveEmitters,
            liveParticles: liveParticles,
            createdFresh: stats.createdFresh,
            reused: stats.reused,
            destroyed: stats.destroyed,
            destroyBlockedByLiveReference: stats.destroyBlockedByLiveReference,
            reclaimedAfterSystemDestroy: stats.reclaimedAfterSystemDestroy
        };
    }

    if (typeof window !== "undefined") {
        window.__mtParticleDebugSnapshot = getSnapshot;

        var overlay = null;
        var overlayTimer = null;

        function renderOverlay() {
            if (!overlay) {
                return;
            }

            var s = getSnapshot();
            overlay.textContent =
                "Particle experiment\n" +
                "types: " + s.liveTypes + " / registry " + s.typeRegistryLength +
                " (holes " + s.typeRegistryHoles + ")\n" +
                "free: " + s.reusableTypeIds + " | pending: " + s.pendingTypeIds + "\n" +
                "systems: " + s.liveSystems + " | emitters: " + s.liveEmitters + "\n" +
                "particles: " + s.liveParticles + "\n" +
                "fresh: " + s.createdFresh + " | reused: " + s.reused +
                " | destroyed: " + s.destroyed;
        }

        window.__mtParticleDebugOverlay = function (enabled) {
            if (!enabled) {
                if (overlayTimer != null) {
                    window.clearInterval(overlayTimer);
                    overlayTimer = null;
                }
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                overlay = null;
                return;
            }

            if (overlay || !document.body) {
                return;
            }

            overlay = document.createElement("pre");
            overlay.id = "mt-particle-debug";
            overlay.style.position = "fixed";
            overlay.style.left = "8px";
            overlay.style.top = "8px";
            overlay.style.zIndex = "2147483647";
            overlay.style.margin = "0";
            overlay.style.padding = "6px 8px";
            overlay.style.background = "rgba(0,0,0,0.72)";
            overlay.style.color = "#fff";
            overlay.style.font = "12px/1.35 monospace";
            overlay.style.pointerEvents = "none";
            document.body.appendChild(overlay);

            renderOverlay();
            overlayTimer = window.setInterval(renderOverlay, 250);
        };

        function maybeEnableOverlay() {
            if (window.location && window.location.search &&
                window.location.search.indexOf("particledebug=1") !== -1) {
                window.__mtParticleDebugOverlay(true);
            }
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", maybeEnableOverlay, false);
        } else {
            maybeEnableOverlay();
        }
    }

    if (typeof console !== "undefined" && console.info) {
        console.info("[MT particle experiment] safe particle type slot reuse patch active");
    }
})();
