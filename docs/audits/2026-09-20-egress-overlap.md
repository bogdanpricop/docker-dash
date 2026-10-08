# Egress: pastrarea filtrului pentru politici suprapuse

Un container poate apartine simultan unei politici individuale si unei politici
de stack. Ambele folosesc tabela `ip ddout`; vechiul unapply stergea tabela fara
sa verifice celelalte politici. Astfel, eliminarea unei politici putea anula
filtrarea ceruta de alta politica ramasa activa.

## Corectie

Runner-ul citeste politicile curente dupa rezervarea tintei pe daemon si salvarea
snapshot-ului, inaintea stergerii regulilor. Exclude numai politica selectata,
dupa validarea identitatii, scope-ului si hostului. Daca mai exista o politica
activa aplicabila, pastreaza tabela si raporteaza `retained`, `retainedFor` si
prezenta reala a regulilor. Un apel direct fara policyId protejeaza toate politicile.
O eroare de citire a politicilor refuza stergerea.

Regulile comune de scope sunt folosite si la autorizarea conexiunilor: ID complet
sau prefix valid, eticheta Compose, acelasi host si aliasul hostului implicit.
La eliminare, prefixele sunt tratate conservator; autorizarea pastreaza verificarea
suplimentara de unicitate in inventarul live. Politicile audit-only sunt protejate
deoarece si jurnalizarea lor necesita redirectionarea catre proxy.

Stack unapply separa containerele cu tabela pastrata de cele cu tabela eliminata
si de esecuri. API-ul si auditul nu mai numesc o tabela pastrata "unapplied".
Interfata explica faptul ca politica selectata ramane configurata. Emergency
disable poate apoi elimina doar configuratia selectata, lasand filtrul celorlalte.

Nu exista un istoric individual complet de apply pentru fiecare politica; orice
politica activa salvata protejeaza conservator tabela comuna. O tabela deja
absenta nu este recreata de unapply si nu este raportata ca prezenta. Politicile
noi necesita in continuare apply explicit; o aplicare concurenta este supusa
rezervarii Docker, fara a presupune ca salvarea configuratiei inseamna enforcement.

## Dovezi

- 356 suite, 4.668 teste trecute, un test live existent omis; lint fara avertismente.
- Teste pentru suprapunere, scope/host/alias, prefixe, mod audit, configuratii
  inactive, identitate invalida, eroare DB, momentul verificarii sub rezervare,
  raportare HTTP/audit si interactiuni UI.
- Sapte scenarii native pe fiecare host: container unapply pastreaza stack;
  dezactivarea configuratiei containerului pastreaza stack; stack unapply pastreaza
  containerul individual si elimina membrul exclusiv; dezactivarea stack-ului
  pastreaza containerul; identitatea unei politici de alt host este refuzata;
  apelul fara policyId protejeaza toate politicile; ultima politica permite stergerea,
  ignorand politicile inactive sau ale altui host.
- Comparatie a regulilor nftables reale inainte/dupa, baza de politici in memorie,
  numai namespace-uri temporare proprii. Toate resursele au fost eliminate.

[Dovezi structurate](2026-09-20-egress-overlap.json).
Corectia este inclusa in sursa 8.96.6; starea instalarii este consemnata separat
in raportul de deploy. Limitele IPv6/non-TCP, exceptiile private/DNS, conexiunile
existente si reconcilierea dupa restart raman deschise.
