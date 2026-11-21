# Plugins

A plugin is a directory under `plugins/` with a `plugin.json`:

    { "name": "aurora", "entry": "./index.ts" }

The sky map's loader imports the entry module from the plugin's directory, at a path it builds
at run time, and calls the module's `activate(host)`. The host lets a plugin read the
observer's latitude and add a layer; `activate` returns the plugin's name.

A plugin that fails to load is reported and skipped, so one broken plugin never blanks the map.
