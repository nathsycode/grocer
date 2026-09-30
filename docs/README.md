# Documentation map

Start with [GOAL.md](../GOAL.md) for durable product intent and [AGENTS.md](../AGENTS.md) for the agent operating contract.

| Location | What belongs here | When to read or update it |
| --- | --- | --- |
| [product/](product/README.md) | Product behaviour, user journeys, terminology, and future acceptance specifications | Changing what users experience or what counts as a correct outcome |
| [adr/](adr/README.md) | Proposed and accepted architecture decisions, their rationale, consequences, and alternatives | Debating or changing a consequential technical choice |
| [architecture/](architecture/README.md) | Descriptions and diagrams of architecture emerging from accepted ADRs | Understanding or documenting how chosen components fit together |
| [integrations/landmark/](integrations/landmark/README.md) | Landmark-specific evidence, limitations, and reference material | Investigating or modifying Landmark integration behaviour |
| [investigations/](investigations/README.md) | Time/context-bounded research, experiments, evidence, and unresolved findings | Testing a hypothesis without yet making a decision |
| [development/](development/README.md) | Contributor setup, validation, and operational development guidance | Establishing or using actual repository tooling |

## Knowledge status

- **Known:** directly observed evidence, with provenance and limits, or explicitly defined product behaviour. Observed retailer behaviour is not a guaranteed API contract.
- **Hypothesis:** a plausible direction awaiting investigation or architectural validation. Label it as tentative.
- **Decision:** a deliberately chosen direction. Record consequential architecture decisions in ADRs; only accepted ADRs govern architecture.

Keep authoritative detail in one appropriate location and link to it elsewhere. Investigation evidence can inform an ADR but does not become a decision by being documented. Product requirements in GOAL.md are defined intent, not proof of implemented capabilities.

## Bootstrap status

This repository began as a documentation-only bootstrap. The initial MVP architecture interview is complete; the [ADR index](adr/README.md#records) tracks accepted decisions, including the frozen first-slice scope. Follow the [first build sequence](architecture/README.md#first-build-sequence), resolving [remaining questions](architecture/adr-questions.md) only as needed.

The first implementation slice (ticket 01) is a local rehearsal against synthetic catalogue and cart data with no live retailer or model calls. Its stack is recorded in [ADR-0009](adr/0009-rehearsal-slice-implementation-stack.md) (Proposed); setup, commands, and safety notes are in the [development guide](development/README.md). The supplied Landmark evidence is recorded in [observations](integrations/landmark/observations.md); live integration remains unimplemented.
