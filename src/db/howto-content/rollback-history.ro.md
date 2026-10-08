---
slug: rollback-history
title: Container rollback history and recovery
title_ro: Istoricul de rollback si recuperarea containerelor
category: docker-dash
difficulty: intermediate
icon: fas fa-history
summary: Understand encrypted rollback configuration, key recovery and backup limits.
summary_ro: Intelege configuratia criptata de rollback, recuperarea cheii si limitele backup-urilor.
---

## Ce pastreaza istoricul

Update, safe update, pipeline si rollback salveaza configuratia curenta inainte
de inlocuire. Variabilele de mediu, comenzile, etichetele si mount-urile pot
contine secrete. Intregul snapshot este criptat cu `ENCRYPTION_KEY` al instalarii.
Dialogul afiseaza metadate despre imagine si deploy, fara configuratia privata.

Migrarea 176 cripteaza snapshot-urile existente la pornire. Daca migrarea esueaza,
modificarile anterioare ale tranzactiei sunt anulate. Configuratia istorica invalida
ramane criptata, dar nu poate fi restaurata. Operatiile ulterioare se opresc
inainte de modificarea containerului daca salvarea snapshot-ului esueaza.

## Recuperarea unei versiuni

Deschide **Rollback** pentru container si selecteaza o imagine anterioara disponibila
pe hostul Docker ales. Operatia recreeaza containerul si poate intrerupe serviciul.
Operatorul trebuie sa aiba permisiuni pentru stack-ul curent si cel din configuratia
salvata. Nu poate folosi istoricul altui host sau altui nume de container. Snapshot-ul
autentificat este legat si de identitatea originala a containerului si a imaginii.

Pastreaza `ENCRYPTION_KEY` stabila, cu backup separat si acces limitat administratorilor
de incredere. Cheia gresita/lipsa sau datele corupte blocheaza rollback-ul inainte
de oprirea containerului. Recupereaza cheia corecta din backup; nu dezactiva
validarea si nu inlocui datele criptate cu JSON. Intrarea istorica fara snapshot
poate fi folosita doar de administrator, cu configuratia curenta si imaginea veche.

## Limitele backup-ului si recuperarii

Criptarea randurilor active nu sterge textul vechi din backup-uri, copii WAL SQLite,
pagini libere sau snapshot-uri de stocare. Restrictioneaza accesul si aplica politica
ta de retentie. Roteste secretele care ar fi putut fi expuse. Cheia impreuna cu baza
de date permit decriptarea, deci protejeaza-le pe amandoua. Nu se introduce o noua
expirare automata a istoricului.

Dialogul afiseaza zece intrari; cele mai vechi nu sunt sterse automat. Recuperarea
containerului nu anuleaza scrierile in volumele comune. O migrare incompatibila a
bazei de date poate necesita restaurarea separata a datelor aplicatiei.

## Recuperare automata la inlocuire

Update, safe update, pipeline si rollback pastreaza originalul oprit pana cand
inlocuitorul trece verificarea si auditul/starea sunt salvate impreuna. La erori de
creare, pornire, healthcheck sau audit se incearca restaurarea aceluiasi ID original,
a numelui, politicii de restart si retelelor. Volumele anonime isi pastreaza numele
Docker. Snapshot-urile noi includ healthcheck, semnalul de oprire si configuratia
retelelor. Cele vechi nu pot recupera informatii care nu au fost salvate.

Fara healthcheck, procesul trebuie sa ramana pornit cinci secunde; verificarea
healthcheck are limita de 30 de secunde. Skip Verify din pipeline omite healthcheck,
dar verifica in continuare procesul. Un container oprit ramane oprit. Verificarea
initiala nu garanteaza functionarea continua.

Update-ul individual foloseste hostul selectat inclusiv pentru containere Compose.
Pentru fisiere Compose si dependente foloseste operatiile de stack. Containerele
cu auto-remove, paused, restarting, dead sau administrate de Swarm sunt refuzate.
O rezervare de nume pe daemon blocheaza inlocuirile concurente din dashboard.
Nu expira automat. Alte unelte Docker si comenzile prune nu respecta rezervarea.

## Operatie intrerupta sau curatare necesara

Mesajul include ID-ul operatiei. Inlocuitorul validat poate ramane activ chiar daca
stergerea originalului pastrat sau a rezervarii esueaza. Nu repeta update-ul si nu
folosi prune pentru a elimina avertizarea.

1. Opreste instantele dashboard care executau operatia si confirma ca nu pot relua
   scrierile. Foloseste daemonul corect si fa un backup protejat al datelor.
2. Citeste randul din `container_replacements`: `daemon_id`, `original_id`,
   `candidate_id`, `lock_id`, `recovery_name`, `history_id`, `phase`,
   `was_running`, `restart_policy`. Istoricul criptat asociat contine configuratia
   initiala a retelelor; jurnalul nu include secretele din environment.
3. Verifica ID-urile si eticheta `com.docker-dash.replacement` a candidatului si
   rezervarii. Nu sterge resurse doar pe baza prefixului `dd-`. Originalul poate
   avea numele `dd-recovery-<ID operatie>`.
4. Pentru `committed`, `complete` sau `cleanup_required`, confirma ca inlocuitorul
   este serviciul activ dorit. Sterge numai resursele pastrate identificate, fara
   volume. Daca originalul a fost deja sters, poate ramane doar rezervarea.
5. Pentru o faza intrerupta inainte de commit sau `recovery_required`, pastreaza
   originalul. Administratorul poate opri/sterge candidatul identificat fara volume,
   restaura numele si retelele originalului din snapshot, politica de restart si
   starea pornit/oprit. Verifica porturile, aliasurile, adresele statice si datele.
6. Sterge rezervarea identificata ultima, dupa verificarea serviciului si a
   proprietatii resurselor. Pastreaza jurnalul si istoricul drept dovezi.

Dupa o intrerupere, Docker poate fi cu un pas inaintea jurnalului. Verifica starea
reala inainte de interventie. Nu prelua o rezervare doar pentru ca este veche.
