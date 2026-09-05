---
'@kernhq/module-tracker': patch
---

Every list in the tracker that could only say "there is nothing here" now says when it failed
instead, with a Retry. A project's pages no longer report "No project called KERN" when the project
list did not arrive, the sidebar no longer tells a workspace full of projects to make its first one,
the planning, projects, import, repeating and workflow settings say what failed, and a dashboard
count tile no longer renders a confident "0" for a query that never came back.
