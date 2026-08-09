Plugin nav panel rows currently support a title and icon, but no content on the right.

It would be useful to allow a small trailing accessory for live values, such as an open task count:

`Tasks                  12`

Something like an optional `sidebarAccessory` component on `navPanel` could work. The host could limit its size and hide it in compact mode. Existing plugins would be unaffected.

This would avoid plugins needing to modify bb's DOM.
