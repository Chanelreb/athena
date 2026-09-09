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
household_members (household_id, user_id, display_name, role, joined_at)
                  -- role: 'adult' | 'child'
household_invites (id, household_id, email, invited_by, accepted_at, expires_at)

tasks             (id, owner_id, household_id, assignee_id,
                   title, note, category, priority,
                   due, date_type, minutes, repeat, created_at, done_at)
                  -- household_id null  = a private task, nobody else sees it
                  -- assignee_id        = whose list it appears in
```

Policies, roughly: you can read a task if you own it, are assigned it, or are a
member of its household. You can assign within your household. Only an adult
can assign to a child.

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
4. **Can a child reassign or assign upward?** Probably not by default.

## 6. The awkward practical problem: children without email

Sign-in is a magic link to an email address. A young child may not have one.
Three ways out:

- **Managed members.** A person in the household with **no login**, whose tasks
  appear on the parent's device. Simplest, works for young kids, but they never
  get the satisfaction of ticking their own things off, which is most of why
  this would work on a child.
- **A household device.** One shared tablet, one account, several named people.
  Cheap, but it is not really multi-user.
- **Parent-created accounts.** The parent sets up an address the child can use.
  Real accounts, real ticking, but more setup and a duty of care about a child's
  data that is worth thinking about properly.

**This is the first thing to decide**, because it changes the auth model, not
just the schema.

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

- Children without email: managed members, a shared device, or real accounts?
- Tasks only, or should household members see more of each other?
- Is this a household of adults sharing a home, or parents and kids? The
  permission model differs.
- Does this want to wait until you and one friend have actually lived in Athena
  for a few weeks? It is the biggest thing on the list and the least reversible.
