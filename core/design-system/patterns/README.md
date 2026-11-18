# Patterns

Patterns start empty and grow from approved screens. A pattern is extracted
only when a second screen needs something similar and the user task, states
and behavior match closely enough that improving one should carry over to
the other.

## Spec format

Each pattern gets its own file with these sections:

- **Use when**
- **Not when**
- **Anatomy**
- **Rules**
- **States**
- **Mobile**
- **Copy**

## Candidates

The owner has confirmed these rules, but there is no spec yet because no
approved screen needs one. Follow the rule; don't invent the rest.

- **Temporary surfaces.** A short, scoped task doesn't replace the whole
  page. Use the web surface that fits the task: dialog, popover, menu or
  inline expansion. Match the interaction's scope to the UI's scope.
- **Entity detail.** On a page that represents one entity, the user
  understands what they are looking at before seeing management controls.
  How strong the identity treatment is depends on the content. It doesn't
  imply a giant hero.
