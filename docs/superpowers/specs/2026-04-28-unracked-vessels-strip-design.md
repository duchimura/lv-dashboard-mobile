# Unracked Vessels Strip — Design Spec
**Date:** 2026-04-28

## Overview

Add a dynamic inline strip to the dashboard footer that lists the names of all vessels currently not assigned to any rack slot. The strip integrates with the existing "find vessel" search so matching vessel names are highlighted. The debug button is moved to the far right of the footer.

---

## Data Layer (`background.js`)

### Storage
Add a module-level variable:
```js
let unrackedVessels = []; // [{ id, name }, …]
```
`name` = `vessel.human_name ?? vessel.name`.

### Computation
Unracked vessels are computed in two places that already fetch both `rack-groups` and `vessels`:

1. **Startup IIFE** — after building `dashboardState`, compute the set of vessel IDs referenced by any `rack.vessel`, then filter `vessels` to those not in the set. Store result in `unrackedVessels`.
2. **`refreshRackState()`** — same logic after the rack-groups loop completes.

In both cases the computation is:
```js
const rackedIds = new Set(
  rackGroups.flatMap(g => g.racks.map(r => r.vessel)).filter(Boolean)
);
unrackedVessels = vessels
  .filter(v => !rackedIds.has(v.id))
  .map(v => ({ id: v.id, name: v.human_name ?? v.name }))
  .sort((a, b) => a.name.localeCompare(b.name));
```

### Messaging
- **`dashboard:get` response** changes from `{ state }` to `{ state, unrackedVessels }`.
- **Push on change**: after `refreshRackState()` recomputes, compare the sorted name list to the previous value. If changed, broadcast to all dashboard tabs:
  ```js
  { type: "dashboard:unracked-update", unrackedVessels }
  ```

---

## HTML (`dashboard.html`)

Add `#unracked-strip` inside `#legend`, between the last legend item and `#debug-toggle`:

```html
<div id="unracked-strip" style="display:none">
  <span id="unracked-label">Out of rack:</span>
  <span id="unracked-names"></span>
</div>
```

`#debug-toggle` remains the last child of `#legend` so `margin-left: auto` in CSS pushes it to the far right.

---

## CSS (`dashboard.css`)

```css
#debug-toggle {
  margin-left: auto; /* push to far right */
}

#unracked-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  overflow-x: auto;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 0;
}

#unracked-label {
  font-weight: bold;
  flex-shrink: 0;
}

#unracked-names .unracked-name {
  /* inline — comma separation handled by JS */
}

#unracked-names .unracked-name.vessel-highlight {
  /* reuses existing vessel-highlight class */
  outline: 2px solid #00bcd4;
  border-radius: 2px;
}
```

---

## Dashboard Logic (`dashboard.js`)

### State
```js
let unrackedVessels = []; // [{ id, name }, …]
```

### `loadInitialState()`
Read `resp.unrackedVessels` from the `dashboard:get` response and store it, then call `renderUnrackedStrip()`.

### `onMessage` handler
Add a case for `dashboard:unracked-update`:
```js
if (msg.type === "dashboard:unracked-update") {
  unrackedVessels = msg.unrackedVessels || [];
  renderUnrackedStrip();
  applyVesselHighlight();
}
```

### `renderUnrackedStrip()`
Rebuilds `#unracked-strip` and `#unracked-names`:
- If `unrackedVessels` is empty: hide `#unracked-strip`.
- Otherwise: show it, create a `<span class="unracked-name">` per vessel, join with `", "` text nodes between them.

### `applyVesselHighlight()` extension
After the existing `.card` loop, add a loop over `.unracked-name` spans:
```js
document.querySelectorAll(".unracked-name").forEach(span => {
  const name = span.dataset.name || "";
  if (vesselSearchTerm && name.toLowerCase().includes(vesselSearchTerm)) {
    span.classList.add("vessel-highlight");
  } else {
    span.classList.remove("vessel-highlight");
  }
});
```
Each `<span class="unracked-name">` carries `data-name="<vesselName>"`.

---

## Behaviour Summary

| Scenario | Result |
|---|---|
| No unracked vessels | `#unracked-strip` hidden |
| Vessels unracked | Strip shows `Out of rack: 001, 010, 020` |
| Search term matches an unracked name | That name span gets `.vessel-highlight` outline |
| Search term clears | All highlights removed |
| `refreshRackState()` detects change | Push message updates strip in real time |

---

## Out of Scope
- Clicking a vessel name to navigate or focus a card (vessels not in any rack have no card).
- Vessel count badge or overflow truncation.
- Filtering/sorting options beyond alphabetical by name.
