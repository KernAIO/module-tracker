---
'@kernhq/module-tracker': patch
---

The last two places in the tracker that answered a failed request with "there is nothing here" now
say that something went wrong and offer a Retry: the issue picker used to report "No issue matches"
when the search had not run, and the timer widget used to report no timer running to someone whose
clock was going.
