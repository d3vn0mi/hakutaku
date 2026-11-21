# aurora

A sky map plugin that adds a layer named `aurora`: its strength at a given day is the chance of
seeing an aurora from the observer's latitude, from a modelled planetary K index.

`plugin.json` names `index.ts` as the entry. The sky map's plugin loader imports it and calls
its `activate` function with a host that can add layers.
