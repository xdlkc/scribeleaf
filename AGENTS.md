# Scribeleaf

Build a usable macOS Markdown editor that reproduces installed Typora 1.14.10.
Reference: `/Applications/Typora.app`. Inspect its resources read-only. Write an
independent implementation; do not embed the original minified application.

User communication: Simplified Chinese. Keep reports concise and evidence based.
Use subscribed DeepSeek/Grok/Kimi harnesses for substantial implementation.
Canonical requirements: `SPEC.md`. Record actual verification and remaining gaps
in `STATUS.md`. Never claim complete parity without evidence.

Current ownership: all previous implementation workers returned. Coordinator owns
integration, branding and publication. Product name: Scribeleaf. Build output:
`build/Scribeleaf.app` (Full, default) or `build/Lite/Scribeleaf.app`, executable Scribeleaf.
Lite and Full share the existing bundle identity and are mutually exclusive install choices. The internal bundle identifier
`local.typora-replica.editor`, bridge names and storage keys remain for compatibility.
Do not rename these without a migration plan. Historical evidence uses the old
product name and is preserved as captured, including original screenshot labels.

Source includes Files/Image/Markdown preference categories and their consumers.
Scoped verification: file preferences150, native file workflow83, file import86,
image native50 + DOM51, Markdown127, drop DOM31 + injected native7. Consult the
actual evidence files for covered behavior and source hashes. Branding changes
invalidate exact hashes of affected files; old tests are not a rerun on new source.
The complete Preferences pixel/focus review is still unfinished. Appearance and
General categories remain partial. No complete 1:1 parity claim is justified.
The old native export runner's artificial restart sentinel failure is preserved;
a separate production Store proof passed9/9. Do not rewrite old evidence.
No subscribed backend harness or QA app is intentionally running. Do not touch
original Typora or user documents/settings. See STATUS.md for remaining gaps.

PDFExportOptions API:
init(values,variables), apply(to:), finalize(source:destination:). PNG adds
pixelScale default 1.
Coordinator owns documentation, original-app UI and final
integration; do not touch original Typora/user settings. Static reference:
evidence/export-settings-reference.json. Current evidence is in STATUS.md.

Verified subscribed harness: `/Users/lkc/.local/bin/grok --model grok-4.6`
with `--reasoning-effort low --no-subagents --disable-web-search --no-plan
--permission-mode auto --output-format streaming-json --prompt-file <brief>`.
Use a bounded task and follow it to verified completion. Grok 4.7 ID was rejected.
The latest real Grok run exited with HTTP 402 (usage balance exhausted), after
eight turns. Do not restart it without new evidence that the balance recovered.
For small new audits, add `--max-turns 24` (flag verified in local help); adjust
the bound to the task and continue a stopped session only when useful.
Kimi K3 produced the initial renderer. Current ~/.kimi-code model kimi-code/k3
also passed a tool-free READY prompt. A later private-project source audit was
rejected by automatic approval review because authorization to transmit source
to that external destination was unconfirmed. That audit did not run; local
review completed it. Do not bypass the rejection or infer authentication failure.
Latest bounded low-cost harness check (public UI specification only): pi
DeepSeek Flash exited before invocation because no API key was configured;
dsh headless failed in its local loader (missing api-gateway package and
credential version type mismatch). No credentials/configuration were edited.
An isolated Kimi K3 agent with tools/subagents disabled and OS-denied project
reads returned no content within150s, then was terminated. Do not re-run these
unchanged failures. Details: evidence/preferences-ui-harness.json.
Native keyboard QA: inactive-app Cmd+Z delivery did nothing; foreground
activation then Cmd+Z correctly reverted the paired-input test and cleared
Edited. Check focus before diagnosing a product Undo failure. A screenshot
observation timeout or AX-only response is not proof the app stopped.
Do not infer authentication failure from `grok models`: actual prompt runs work.
No user global model/authentication configuration was changed.
Some earlier Grok and browser CLI escalation attempts were not executed because
automatic approval review was at capacity. Later approved Grok runs and isolated
Chromium sessions did execute. Do not infer authentication failure or retry an
unobserved live process based on an old approval error. No permissions were bypassed.

Do not repeat broad completed checks unless changes or unresolved concerns
justify them. Build: `bash scripts/build-macos.sh`. Use
`TYPORA_RENDERER_OUT_DIR=.cache/native-dist` to avoid a shared dist collision.
Primary regression evidence and remaining product gaps are in STATUS.md.
PARITY-MENUS.md is a captured menu label inventory, not proof of behavior.

Do not overwrite files owned by another active worker. Do not change unrelated
projects, user configuration or Typora. No credentials in logs or repository.
