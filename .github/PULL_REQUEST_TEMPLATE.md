<!--
Thank you for contributing. Please read CONTRIBUTING.md first.
A security problem goes to SECURITY.md, never to a pull request.
The title must be a Conventional Commit, such as "fix(extract): ...": it becomes the squash commit.
-->

## What and why

<!-- What does this change, and why? Link the issue or discussion, for example "Closes #<number>". -->

## How it was tested

<!-- The tests you added or changed. If an answer changed, say how the golden answers changed, and why. -->

## Checklist

- [ ] The title is a Conventional Commit, such as `feat(query): ...` or `fix(viewer): ...`
- [ ] Tests come with the change, and they pass locally
- [ ] If an answer changed, the golden answers are updated and the reason is given above (`code_explain` only gains fields at the end)
- [ ] Reproduced on the synthetic sample: no private code, private paths, store files or screenshots of a private repository
- [ ] Docs are updated, if a tool, a flag, a format or a behaviour changed
- [ ] No new runtime dependency, or the reason is given above, and every licence is on the allowlist
- [ ] Nothing from the analysed repository runs, and nothing uses the network outside `hakutaku engines install`
