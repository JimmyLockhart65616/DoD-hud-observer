import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'hud.minimap_enabled';

/**
 * Whether the minimap is shown, and a way to turn it off.
 *
 * The minimap is new and expected to be rough, so it has to be dismissible
 * WITHOUT a redeploy — someone mid-broadcast should be able to make it go away
 * and keep working. Resolution order mirrors the broadcast team names
 * (`core/TeamName/teamNames.js`), which solved the same problem:
 *
 *   1. `?minimap=0` / `?minimap=1`  — pinned for this tab, wins outright
 *   2. localStorage                  — the persisted choice on this machine
 *   3. default ON
 *
 * A URL-pinned value renders WITHOUT a toggle button, for the same reason the
 * team-name editor hides when a side is pinned: a control that silently loses to the
 * URL on the next reload is worse than no control at all.
 *
 * Nothing reaches the backend or match state — this is one operator's local
 * display preference, so there is nothing to provision and nothing to reset.
 */
export function useMinimapToggle() {
    const [pinned, setPinned] = useState(null);
    const [enabled, setEnabled] = useState(true);

    useEffect(() => {
        let urlPin = null;
        try {
            const q = new URLSearchParams(window.location.search).get('minimap');
            if (q === '0' || q === 'off' || q === 'false') urlPin = false;
            if (q === '1' || q === 'on' || q === 'true') urlPin = true;
        } catch (e) { /* no URL access — fall through to storage */ }

        if (urlPin !== null) {
            setPinned(urlPin);
            setEnabled(urlPin);
            return;
        }

        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored !== null) setEnabled(stored === '1');
        } catch (e) { /* storage blocked (private mode / OBS) — keep the default */ }
    }, []);

    const toggle = useCallback(() => {
        setEnabled(prev => {
            const next = !prev;
            try {
                window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
            } catch (e) { /* non-persistent is still better than non-functional */ }
            return next;
        });
    }, []);

    return { enabled, toggle, pinned: pinned !== null };
}

export default useMinimapToggle;
