---
name: work-items
description: Read, create, or update Agentwatch Markdown work items and their configurable workflow.
---

# Work items

1. Read `agentwatch.tasks.json` from the project root.
2. Discover Markdown files only below its `paths`.
3. Use YAML frontmatter with at least `title` and `status` for new items.
4. Use only a status listed in `statuses`; default to `defaultStatus` when creating an item.
5. Preserve unknown metadata when editing an existing item.
6. Optional fields include `id`, `type`, `parent`, `priority`, `lane`, and `tags`.
7. Do not introduce Scrum-specific structure unless requested or already established by the project.
