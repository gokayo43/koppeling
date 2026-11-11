# Glossary

The words a koppeling is used in, as an office person meets them. The first
three are the portal's own and mean here what they mean there (the portal's
CONTEXT.md, section "Koppeling").

**Koppeling**: the door through which a program outside our systems, such as
Claude, reads and acts in one of the company's systems (the
portal, the API or the warehouse) for a signed-in office person. The program
acts as that person: what it changes is theirs, and its history says it was
done through the program ("via Claude"). Only office staff can use a koppeling.
The system hears of every operation its koppeling runs, a look-up as much as a
change: which operation, for whom, through which program, and how it ended.
_Avoid_: "agent" for the program, "program" for the system.

**Koppelingsinlog**: the one-time sign-in and consent a person gives a program
in the browser, with their portal account. A second connection of the same
program asks nothing, until the person disconnects the program in their board
profile, the page in the portal where they manage their own account; the
program then stops within a quarter of an hour.

**Koppelingstoken**: a personal token a person makes in their board profile
for a program that cannot sign in through a browser, such as one that runs on
a server. It acts as that person until they revoke it, and stops within a quarter
of an hour of that. It never opens the boekhouding.

**Operatie** (operation): one thing a system lets its people do or look up,
such as "zet een order op gepickt" or "de voorraad van een sku". A read
operation only looks something up. A write operation changes something; the
system tells the program to ask the person first, and Claude Desktop does ask.

**Gebied** (area): a part of a system that its operations are grouped by, such
as orders, stock or suppliers, so a person or a program can look through one
part at a time.

**Toegang** (scope): a part of a system that a koppelingsinlog gives the
program access to, such as the boekhouding. A person may see an operation that
needs a toegang their inlog did not give; when the program tries it, the
person is asked to sign in again and give that toegang.

**Catalogus** (catalogue): every operation a system offers through its
koppeling, as the system itself declares them when it starts.

**Vervolg** (continuation): the next part of an answer too long to give in one
go. The koppeling gives a long answer in parts, and each part says which part
it is and how to ask for the next; the parts put together are the whole answer,
so nothing is ever left out.
