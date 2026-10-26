# Glossary

The words a koppeling is used in, as an office person meets them. The first
three are the portal's own and mean here what they mean there (the portal's
CONTEXT.md, section "Koppeling").

**Koppeling**: the door through which a program outside our systems, such as
Claude or another agent, reads and acts in one of the company's systems (the
portal, the API or the warehouse) for a signed-in office person. The program
acts as that person: what it changes is theirs, and its history says it was
done through the program ("via Claude"). Only office staff can use a koppeling.

**Koppelingsinlog**: the one-time sign-in and consent a person gives a program
in the browser, with their portal account. A second connection of the same
program asks nothing, until the person disconnects the program in their board
profile, the page in the portal where they manage their own account; the
program then stops within a quarter of an hour.

**Koppelingstoken**: a personal token a person makes in their board profile
for a program that cannot sign in through a browser, such as an agent on a
server. It acts as that person until they revoke it, and stops within a quarter
of an hour of that. It never opens the boekhouding.

**Operatie** (operation): one thing a program lets its people do or look up,
such as "zet een order op gepickt" or "de voorraad van een sku". A read
operation only looks something up. A write operation changes something; the
program tells the agent to ask the person first, and Claude Desktop does ask.

**Gebied** (area): a part of a program that its operations are grouped by, such
as orders, stock or suppliers, so a person or an agent can look through one
part at a time.

**Catalogus** (catalogue): every operation a program offers through its
koppeling, as the program itself declares them when it starts.
