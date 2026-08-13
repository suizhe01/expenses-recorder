# Receipt extraction corpus

Each case is a committed receipt image with a sibling JSON file of the expected observable extraction. Add a case by copying in an image, creating a JSON file with the same basename, and hand-verifying every JSON value against the paper receipt.

Expected JSON is never captured from a model run. That would preserve the model's mistake and make this evaluator vacuous. `confidence` is deliberately omitted because it is model output rather than a fact printed on paper.

All images here are the developer's own receipts and contain no third-party personal data. Before adding an image, redact or omit any sensitive information.

Run `npm run eval:extraction` deliberately with `GEMINI_API_KEY` set. It makes live, billable model calls and is not part of CI or `npm test`.
