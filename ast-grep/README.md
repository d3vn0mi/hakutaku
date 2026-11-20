# hakutaku's ast-grep rules

These are hakutaku's own ast-grep rules, one file per language under `rules/`. Every export copies
this directory beside the snapshot and writes an `sgconfig.yml` that names it, and extract passes
that config to ast-grep explicitly, so an analysed repo's own ast-grep config is never read.

Author: d3vn0mi.
