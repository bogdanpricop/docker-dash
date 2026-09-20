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

Dialogul afiseaza zece intrari; cele mai vechi nu sunt sterse automat. Criptarea
nu face inlocuirea containerului tranzactionala. O eroare dupa stergerea containerului
curent din Docker poate necesita recuperare manuala. Pastreaza separat configuratia
de deploy si backup-uri independente.
