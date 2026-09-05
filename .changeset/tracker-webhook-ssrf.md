---
'@kernhq/module-tracker': minor
---

The workflow "Call webhook" post-function can no longer be pointed at the network the service runs
on. It sent a request to whatever URL a workspace admin typed, so on a hosted instance — where
signing up makes you the owner of a workspace — it could be aimed at the other services on the
internal network or at the cloud provider's metadata endpoint, with a method, headers and a body of
the caller's choosing.

A webhook now has to be http or https, its hostname is resolved before anything connects and refused
if it lands on a loopback, private, link-local, unique-local, multicast or reserved address, and the
socket goes to the address that was checked rather than to a second lookup that could answer
differently. Redirects are no longer followed, because the address a redirect names is one nothing
has checked. Responses are capped and the call times out.

Anyone whose workflow calls a webhook on their own internal network will see it refused, with the
address and the reason in the service log.
