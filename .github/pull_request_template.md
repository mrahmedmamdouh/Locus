## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Area

- [ ] `packages/altitude-core`
- [ ] `app/` (Expo field-test app)
- [ ] `dashboard/`
- [ ] CI / docs

## Checklist

- [ ] `npm test --workspaces --if-present` passes
- [ ] `npm run typecheck --workspaces --if-present` passes
- [ ] If the CSV schema changed (`packages/altitude-core/src/csv.ts`): app export and dashboard import both updated, and old CSVs still parse or the break is called out
- [ ] If the gate criteria or floor math changed: docs updated (`README.md`, `docs/field-test-protocol.md`)
- [ ] No personal data, real customer data or field-test CSVs committed
- [ ] Tested on a device (app changes only): model + OS:

## Notes for reviewers

<!-- Anything risky, follow-ups, screenshots. -->
