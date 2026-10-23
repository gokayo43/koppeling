# Glossary

The words this package is written in. One entry per term, defined by what it
means to the people who use a koppeling, never by how it is built.

**Koppeling**: the door through which a program outside our systems, such as
Claude or another agent, reads and acts in one of them on behalf of a signed-in
office person. The program acts as that person, and what it does is recorded as
that person's.

**Koppelingsinlog**: the one-time sign-in and consent a person gives a program
in the browser: they sign in with their portal account and allow the program
once. A second connection of the same program by the same person asks nothing,
until the person disconnects the program in their board profile.

**Koppelingstoken**: a personal token a person creates in their board profile
for a program that cannot sign in through a browser, such as an agent on a
server. It acts as that person until they revoke it.

**Operatie** (operation): one callable thing a program declares: a tRPC
procedure, or an Elysia route. A read operation changes nothing; a write
operation changes data, and the person is asked before it runs.

**Gebied** (area): the part of a program an operation belongs to: a router's
top-level key, or a route path's first segment.

**Catalogus** (catalogue): the list of a program's operations, as the program
itself declares them when it starts.
