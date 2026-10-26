# Contributing to F12x

Thanks for helping improve F12x. This project is licensed under
**AGPL-3.0-only**; by submitting a contribution you agree that it is licensed
under the same terms.

## Before you start

- Open an issue for non-trivial changes so scope can be agreed first.
- Do not include real cookies, tokens, customer data, or third-party code
  without a compatible license.
- Security issues: follow [SECURITY.md](SECURITY.md), do not open a public
  issue.

## Development

1. Fork the repository and create a branch from `main`.
2. Load `F12x/` as an unpacked Chrome extension (`chrome://extensions`).
3. Make the change. Keep the existing architecture:
   - native ESM in `src/`; classic script for `sidepanel/panel.js`
   - no build step, no framework, no backend, no telemetry
   - new storage entities belong in `src/memory.js` or a dedicated module,
     with project-level cascade cleanup
4. Run the local verification harness from the workspace (it lives outside the
   product repository):

   ```bash
   node ../dev/run.mjs
   ```

   It must stay green. There is no npm install.
5. For UI changes, capture screenshots at **900×900** and update
   `README.md` / `docs/USER_MANUAL.md` where relevant.
6. Add a `CHANGELOG.md` entry (what / why / verification / commit hash) using
   the existing format.

## Pull requests

- Keep one topic per PR; avoid unrelated formatting or vendor rewrites.
- Describe the user-visible behavior and how you verified it in a real Chrome
  profile (reload the extension before testing).
- By submitting, you confirm you have the right to contribute the code and
  agree to license it under AGPL-3.0-only.
- Maintainers may ask for changes or decline changes that conflict with the
  product boundaries (no telemetry, no mandatory backend, no auto-scanner).

## License and ownership

- Copyright of F12x remains with the project owner (朝悦 / @gu437).
- Contributors retain copyright of their own contributions; the project
  receives them under AGPL-3.0-only.
- Commercial/closed-source licensing requires separate permission from the
  copyright holder.
