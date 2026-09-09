# Athena: people, households and assigned tasks

A plan, not a build. Nothing here is implemented yet.

> **The short version:** this is the feature that ends the one-blob-per-user
> model. It is roughly the size of Phase B (accounts and sync), and the main
> decision is not technical, it is about privacy inside a family.

---

## 1. What we want

Add the people you live with to Athena, then give them tasks. "Elijah, empty
the dishwasher by Friday." They see it, tick it, and you know it is done.

## 2. Why the current design fights it

Every account today is an island:

- All of your data is **one JSON blob** in a single row keyed to your user id.
- **Row-level security** means literally nobody else can read or write that row.
  That is a feature, not an accident: it is what makes Athena private.

So there is no sharing primitive at all. There is nowhere for a task to live
that two people can both see. Assigning a task to your son means it has to
exist somewhere his account can reach, and right now nothing like that exists.

## 3. The central question: where does an assigned task live?

| Option | How it works | Verdict |
|---|---|---|
| **A. In the assignee's own data** | You write the task into his blob | Fails immediately. Row-level security stops you writing to his row, and you would lose sight of it the moment you created it. |
| **B. In a shared household space** | Tasks belong to a household and carry an assignee | **Recommended.** Both people can see it, each person's own tasks still surface in their own blocks, and permissions are expressible. |
| **C. In your data, "shared to" him** | You keep it, he gets a view | Every read becomes a cross-account join. Complexity with no benefit over B. |

**Recommendation: B.**

## 4. What that costs, and the shortcut

Option B forces tasks out of the JSON blob and into a real table. That is the
relational migration flagged in the original spec.

**The useful shortcut: it does not have to be all-or-nothing.** Blocks, habits,
goals and preferences can stay exactly as they are, in the personal blob. Only
**tasks** move into a table. Personal tasks simply have no household and are
assigned to you. That is a fraction of the work of a full migration and it
delivers the whole feature.

### Sketch of the schema

```sql
households        (id, name, created_by, created_at)
household_members (household_id, user_id, display_name, joined_at)
                  -- no role: everyone is a capable account holder, so
                  -- permissions are symmetric (see section 6)
household_invites (id, household_id, email, invited_by, accepted_at, expires_at)

tasks             (id, owner_id, household_id, assignee_id,
                   title, note, category, priority,
                   due, date_type, minutes, repeat, created_at, done_at)
                  -- household_id null  = a private task, nobody else sees it
                  -- assignee_id        = whose list it appears in
```

Policies, roughly: you can read a task if you own it, are assigned it, or are a
member of its household, and you can assign to anyone in your household.

## 5. The decisions that are actually about privacy

These matter more than the schema, and they are yours to make.

1. **How much do household members see of each other?** My proposal: **tasks
   only**. Not each other's calendars, habits or goals. Athena is a calm
   personal space and a family that can read each other's whole day is a
   different, more fraught product.
2. **Can someone decline a task?** My proposal: they can mark it "not doing"
   with the assigner notified, rather than silently deleting it. Otherwise
   assignment becomes a way to make things vanish.
3. **Does the assigner see completion?** Yes, that is most of the point.
4. **Can anyone assign to anyone?** Yes. With older kids and spouses there is
   no reason for one-way permissions, and symmetry means no role system.

## 6. Children without email: decided, and it is a non-issue

**Decision (Chanel, 2026-09-09): older kids and spouses only, for now.**

Everyone who will use this has their own email address, so they all get real
accounts and sign in the same way you do. That removes the whole problem:

- No managed members with no login.
- No shared household device.
- No accounts created on a child's behalf, and none of the duty-of-care
  questions that would have come with that.
- **The auth model does not change at all.** Magic link, exactly as today.

It also removes the need for **roles**. With capable account holders on both
sides, permissions can be symmetric: anyone in the household can assign to
anyone else. That drops `role` from the schema and deletes a whole class of
"can an adult do X to a child" rules.

If Athena ever wants younger children, revisit this. It would mean managed
members, and it is a real piece of work, not a tweak.

## 7. Getting people in

1. You create a household (or it is created with you in it).
2. You invite by email address.
3. They sign in with that address and are offered the household to join.
4. Until they accept, tasks can be assigned but sit as "waiting for them".

Nobody is added without signing in themselves, so no account is created on
someone's behalf without their say-so.

## 8. Telling them they have been given something

Without push notifications, the honest answer is **next time they open Athena**.
Worth setting expectations: assigning a task is not the same as telling someone.
Options later are email on assignment (we already have an email service in the
plan) or web push once it is built.

## 9. Suggested build order

1. **Households and membership.** Create, invite, accept. No tasks yet.
2. **Tasks move to a table.** Same behaviour as today, personal only, migrated
   out of the blob. Nothing user-visible changes, which makes it safe to verify.
3. **Assignment.** Assign, see "given to me", tick, assigner sees it done.
4. **Polish.** Declining, per-person filters, a family overview if wanted.

Step 2 is the risky one and should ship on its own, boring and invisible, before
anything is built on top of it.

## 10. Open questions for Chanel

Resolved: children without email (section 6), and the permission model, which is
now symmetric with no roles.

Still open, though I have proposed defaults for both:

- **Tasks only, or more?** Default: tasks only. Household members do not see
  each other's calendars, habits or goals.
- **Declining.** Default: you can mark something "not doing", and the person who
  assigned it is told, rather than it silently disappearing.
- **Timing.** This is still the biggest and least reversible thing on the list.
  Worth asking whether it should wait until you and your friend have actually
  lived in Athena for a few weeks.
