'use strict';

/* ═══════════════════════════════════════════════════
   help-content.js — prose behind every page's "?" button
   ═══════════════════════════════════════════════════

   Keyed by the route name in App._pages. PageHelp injects the button for any
   route with an entry here, so adding help to a page is a content edit.

   The prose lives here rather than in i18n/*.js on the same reasoning that puts
   how-to guides in markdown files: these are paragraphs, not labels, and burying
   them among ~4000 UI strings makes both harder to maintain. English is the
   fallback; a missing `ro` entry degrades to English rather than to a blank.

   Shape:
     'route': { en: { title, icon, intro, sections: [{icon,title,body}], tip },
                ro: { ... } }

   Keep it honest: describe what the page actually does, including what it
   refuses to do. `node scripts/check-page-help.js` fails if a routed page has
   neither an entry here nor its own button.
*/

const HelpContent = {
  'diagnostics': {
    en: {
      title: 'Diagnostic Sessions', icon: 'fa-wave-square',
      intro: 'Answers "what was happening across my estate at 14:32?" by putting containers and VMs on one time axis.',
      sections: [
        { icon: 'fa-clock-rotate-left', title: 'Retrospective, not a collector', body: 'A session stores only which subjects over which window. Every series is re-read from metrics already collected, so creating one changes nothing and costs no extra sampling.' },
        { icon: 'fa-chart-line', title: 'One shared axis', body: 'Bucket N means the same instant for every subject, which is what makes a container and a VM comparable at a glance. Nothing is interpolated to line them up.' },
        { icon: 'fa-square-minus', title: 'A gap is a gap', body: 'Missing data renders as a break in the line, never as zero. A cumulative counter that resets when a container restarts breaks the line too, rather than drawing a cliff.' },
        { icon: 'fa-triangle-exclamation', title: 'Clock skew is reported', body: 'If the sources disagree by more than two seconds you are told, and by how much. The offset is never silently corrected, because that would turn a coincidence into an apparent cause.' },
      ],
      tip: 'Correlation is not causation. A session shows you what happened together; it does not claim one caused the other.',
    },
    ro: {
      title: 'Sesiuni de diagnostic', icon: 'fa-wave-square',
      intro: 'Raspunde la "ce se intampla in parcul meu la 14:32?" punand containere si VM-uri pe aceeasi axa de timp.',
      sections: [
        { icon: 'fa-clock-rotate-left', title: 'Retrospectiv, nu colector', body: 'O sesiune retine doar ce subiecte si ce fereastra. Fiecare serie e recitita din metricile deja colectate, deci crearea ei nu schimba nimic si nu costa esantionare in plus.' },
        { icon: 'fa-chart-line', title: 'O singura axa comuna', body: 'Bucket-ul N inseamna acelasi moment pentru fiecare subiect, ceea ce face comparabile un container si un VM dintr-o privire. Nimic nu e interpolat ca sa se alinieze.' },
        { icon: 'fa-square-minus', title: 'Un gol ramane gol', body: 'Datele lipsa apar ca intrerupere a liniei, niciodata ca zero. Un contor cumulativ care se reseteaza la restartul containerului rupe la fel linia, in loc sa deseneze o prapastie.' },
        { icon: 'fa-triangle-exclamation', title: 'Derapajul de ceas e raportat', body: 'Daca sursele difera cu peste doua secunde esti anuntat, si cu cat. Decalajul nu e corectat tacit, fiindca asta ar transforma o coincidenta intr-o cauza aparenta.' },
      ],
      tip: 'Corelatia nu e cauzalitate. O sesiune arata ce s-a intamplat impreuna; nu pretinde ca una a cauzat-o pe cealalta.',
    },
  },

  'security': {
    en: {
      title: 'Security', icon: 'fa-shield-halved',
      intro: 'Vulnerability scanning for the images you actually run, plus the history of every scan.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Scanning', body: 'Scan a single image or the whole set. Results list CVEs by severity with the fixed version where one exists.' },
        { icon: 'fa-clock-rotate-left', title: 'Scan history', body: 'Every scan is retained so you can tell whether a finding is new or has been sitting there for months.' },
        { icon: 'fa-lightbulb', title: 'Recommendations', body: 'Findings are grouped into concrete upgrade actions rather than a raw CVE dump.' },
      ],
      tip: 'A clean scan means "no known CVEs in this image today" — rescan after each base-image change, not once.',
    },
    ro: {
      title: 'Securitate', icon: 'fa-shield-halved',
      intro: 'Scanare de vulnerabilitati pentru imaginile pe care le rulezi efectiv, plus istoricul fiecarei scanari.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Scanare', body: 'Scaneaza o imagine sau tot setul. Rezultatele listeaza CVE-urile pe severitate, cu versiunea corectata acolo unde exista.' },
        { icon: 'fa-clock-rotate-left', title: 'Istoric', body: 'Fiecare scanare e pastrata, ca sa vezi daca o problema e noua sau sta acolo de luni de zile.' },
        { icon: 'fa-lightbulb', title: 'Recomandari', body: 'Constatarile sunt grupate in actiuni concrete de upgrade, nu intr-o lista bruta de CVE-uri.' },
      ],
      tip: 'O scanare curata inseamna "niciun CVE cunoscut azi" — rescaneaza dupa fiecare schimbare de imagine de baza, nu o singura data.',
    },
  },

  'posture': {
    en: {
      title: 'Security Posture', icon: 'fa-shield-halved',
      intro: 'One score for the whole estate, computed live from checks across hosts, firewalls and providers.',
      sections: [
        { icon: 'fa-gauge-high', title: 'Score and grade', body: 'Findings carry a weighted penalty against 100. The grade is a summary, not the point — the findings are.' },
        { icon: 'fa-list-check', title: 'Findings', body: 'Each finding names the host, the evidence behind it, and a specific fix. Nothing is inferred from telemetry.' },
        { icon: 'fa-bell-slash', title: 'Muting', body: 'Acknowledge a finding you have accepted, permanently or for a set time. Mutes are audited and never silently expire unnoticed.' },
        { icon: 'fa-wrench', title: 'Remediation', body: 'Only genuinely safe fixes are one-click. Anything that could create exposure or lock you out stays guided.' },
      ],
      tip: 'Findings are computed live and never stored — only the score is snapshotted, for the trend.',
    },
    ro: {
      title: 'Postura de securitate', icon: 'fa-shield-halved',
      intro: 'Un singur scor pentru tot parcul, calculat live din verificari peste hosturi, firewall-uri si provideri.',
      sections: [
        { icon: 'fa-gauge-high', title: 'Scor si nota', body: 'Constatarile scad din 100 cu o pondere pe severitate. Nota e un rezumat, nu scopul — constatarile sunt.' },
        { icon: 'fa-list-check', title: 'Constatari', body: 'Fiecare constatare numeste hostul, dovada din spate si o corectie concreta. Nimic nu e dedus din telemetrie.' },
        { icon: 'fa-bell-slash', title: 'Mutare pe silentios', body: 'Confirma o constatare pe care ai acceptat-o, permanent sau pe termen limitat. Mutarile sunt auditate.' },
        { icon: 'fa-wrench', title: 'Remediere', body: 'Doar corectiile sigure sunt intr-un click. Orice ar putea crea expunere sau te-ar putea bloca ramane ghidata.' },
      ],
      tip: 'Constatarile se calculeaza live si nu se stocheaza — doar scorul e salvat, pentru trend.',
    },
  },

  'blueprints': {
    en: {
      title: 'Reconciler', icon: 'fa-code-branch',
      intro: 'Declarative desired state for your firewall: capture what exists, commit it to Git, then plan and converge.',
      sections: [
        { icon: 'fa-camera', title: 'Capture', body: 'Snapshot the live ruleset of a host into a blueprint you can read and review.' },
        { icon: 'fa-code-compare', title: 'Plan', body: 'A plan shows the exact difference between the blueprint and reality before anything is applied.' },
        { icon: 'fa-arrows-rotate', title: 'Converge', body: 'Applying makes reality match the blueprint. Drift detected later is reported, not silently corrected.' },
      ],
      tip: 'Always read the plan. Converging a blueprint captured from the wrong host is how you lock yourself out.',
    },
    ro: {
      title: 'Reconciler', icon: 'fa-code-branch',
      intro: 'Stare dorita declarativa pentru firewall: capteaza ce exista, comite in Git, apoi planifica si converge.',
      sections: [
        { icon: 'fa-camera', title: 'Captura', body: 'Salveaza setul de reguli viu al unui host intr-un blueprint lizibil si revizuibil.' },
        { icon: 'fa-code-compare', title: 'Plan', body: 'Planul arata diferenta exacta dintre blueprint si realitate inainte sa se aplice ceva.' },
        { icon: 'fa-arrows-rotate', title: 'Convergenta', body: 'Aplicarea aduce realitatea la blueprint. Derapajul detectat ulterior e raportat, nu corectat tacit.' },
      ],
      tip: 'Citeste intotdeauna planul. Convergenta unui blueprint captat de pe hostul gresit e felul in care te blochezi singur afara.',
    },
  },

  'procedures': {
    en: {
      title: 'Procedures', icon: 'fa-diagram-project',
      intro: 'Reusable operational runbooks with ordered steps, dependencies, live progress and full audit history.',
      sections: [
        { icon: 'fa-list-ol', title: 'Steps and stages', body: 'Steps run in stages; independent steps in the same stage run in parallel, dependent ones wait.' },
        { icon: 'fa-play', title: 'Running', body: 'Progress is live per step. A failed step stops its dependents rather than pushing on regardless.' },
        { icon: 'fa-clipboard-list', title: 'History', body: 'Every run is retained with who started it and what each step did — a runbook you can prove you followed.' },
      ],
      tip: 'Write the procedure before the incident. Reading it for the first time at 3am is not a plan.',
    },
    ro: {
      title: 'Proceduri', icon: 'fa-diagram-project',
      intro: 'Runbook-uri operationale reutilizabile, cu pasi ordonati, dependinte, progres live si istoric auditabil.',
      sections: [
        { icon: 'fa-list-ol', title: 'Pasi si etape', body: 'Pasii ruleaza in etape; cei independenti din aceeasi etapa ruleaza in paralel, cei dependenti asteapta.' },
        { icon: 'fa-play', title: 'Executie', body: 'Progresul e live per pas. Un pas esuat isi opreste dependentii, nu merge mai departe orbeste.' },
        { icon: 'fa-clipboard-list', title: 'Istoric', body: 'Fiecare rulare e pastrata cu cine a pornit-o si ce a facut fiecare pas — un runbook pe care poti dovedi ca l-ai urmat.' },
      ],
      tip: 'Scrie procedura inainte de incident. Sa o citesti prima oara la 3 noaptea nu e un plan.',
    },
  },

  'copilot': {
    en: {
      title: 'Copilot', icon: 'fa-robot',
      intro: 'A cross-layer security and operations advisor that ranks what deserves your attention and explains why.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'Rule-based by default', body: 'The ranking is deterministic and works with no AI configured. Every item cites the data behind it.' },
        { icon: 'fa-comments', title: 'Optional LLM', body: 'Bring your own model for narrative summaries and Q&A. It is off by default and never required.' },
        { icon: 'fa-hand', title: 'Advises, never acts', body: 'Copilot ranks and explains. It does not change your estate on your behalf.' },
      ],
      tip: 'No telemetry leaves the box unless you explicitly configure an external model.',
    },
    ro: {
      title: 'Copilot', icon: 'fa-robot',
      intro: 'Un consilier de securitate si operatiuni care ordoneaza ce merita atentia ta si explica de ce.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'Bazat pe reguli', body: 'Ordonarea e determinista si functioneaza fara niciun AI configurat. Fiecare element citeaza datele din spate.' },
        { icon: 'fa-comments', title: 'LLM optional', body: 'Poti conecta propriul model pentru rezumate narative si intrebari. E dezactivat implicit si niciodata obligatoriu.' },
        { icon: 'fa-hand', title: 'Sfatuieste, nu actioneaza', body: 'Copilot ordoneaza si explica. Nu iti modifica infrastructura in locul tau.' },
      ],
      tip: 'Nicio telemetrie nu iese din instalare decat daca configurezi explicit un model extern.',
    },
  },

  'firewall': {
    en: {
      title: 'Firewall', icon: 'fa-shield-alt',
      intro: 'Per-host firewall rules applied over SSH or a firewall agent — whitelisted commands, audited, reversible.',
      sections: [
        { icon: 'fa-list', title: 'Rules', body: 'Read the live ruleset per host and add or remove rules. ufw, iptables and nftables are each parsed natively.' },
        { icon: 'fa-lock', title: 'Lockout guard', body: 'The management and SSH ports are protected from being cut off, because a firewall dashboard that can strand you is worse than none.' },
        { icon: 'fa-clock-rotate-left', title: 'Audit', body: 'Every change records who made it and what was applied, so a rule can be traced back to a person.' },
      ],
      tip: 'Restricting a port to a trusted range beats closing it outright — you keep access, the internet does not.',
    },
    ro: {
      title: 'Firewall', icon: 'fa-shield-alt',
      intro: 'Reguli de firewall per host, aplicate prin SSH sau agent — comenzi pe lista alba, auditate, reversibile.',
      sections: [
        { icon: 'fa-list', title: 'Reguli', body: 'Citeste setul viu de reguli per host si adauga sau sterge reguli. ufw, iptables si nftables sunt parsate nativ.' },
        { icon: 'fa-lock', title: 'Protectie la blocare', body: 'Porturile de management si SSH sunt protejate de taiere — un dashboard de firewall care te poate lasa pe dinafara e mai rau decat niciunul.' },
        { icon: 'fa-clock-rotate-left', title: 'Audit', body: 'Fiecare schimbare inregistreaza cine a facut-o si ce s-a aplicat, deci o regula poate fi urmarita pana la o persoana.' },
      ],
      tip: 'Restrangerea unui port la un interval de incredere bate inchiderea lui — tu pastrezi accesul, internetul nu.',
    },
  },

  'hosts': {
    en: {
      title: 'Docker Hosts', icon: 'fa-server',
      intro: 'Every Docker, Podman or platform endpoint Docker Dash talks to, and the health of each connection.',
      sections: [
        { icon: 'fa-plug', title: 'Adding a host', body: 'Connect over socket, TLS or SSH. Test the connection before saving — a host that cannot be reached is worse than one that is absent.' },
        { icon: 'fa-heart-pulse', title: 'Health', body: 'Connection state is polled continuously; an offline host is greyed out rather than silently dropped from views.' },
        { icon: 'fa-key', title: 'Credentials', body: 'Certificates and keys are encrypted at rest. They are never written to logs or audit entries.' },
      ],
      tip: 'Plain TCP without TLS gives anyone who can reach the port root on that host. Use TLS or SSH.',
    },
    ro: {
      title: 'Hosturi Docker', icon: 'fa-server',
      intro: 'Toate endpoint-urile Docker, Podman sau de platforma cu care vorbeste Docker Dash, si starea fiecarei conexiuni.',
      sections: [
        { icon: 'fa-plug', title: 'Adaugarea unui host', body: 'Conectare prin socket, TLS sau SSH. Testeaza conexiunea inainte sa salvezi — un host inaccesibil e mai rau decat unul absent.' },
        { icon: 'fa-heart-pulse', title: 'Sanatate', body: 'Starea conexiunii e verificata continuu; un host offline e estompat, nu scos tacit din liste.' },
        { icon: 'fa-key', title: 'Credentiale', body: 'Certificatele si cheile sunt criptate la repaus. Nu ajung niciodata in loguri sau in audit.' },
      ],
      tip: 'TCP simplu fara TLS da root pe host oricui ajunge la port. Foloseste TLS sau SSH.',
    },
  },

  'about': {
    en: {
      title: 'About', icon: 'fa-circle-info',
      intro: 'Version, licence and build information for this installation.',
      sections: [
        { icon: 'fa-tag', title: 'Version', body: 'The running version, which is what you should quote in a bug report — not the version you deployed.' },
        { icon: 'fa-scale-balanced', title: 'Licence and credits', body: 'Licence terms and the open-source components this build depends on.' },
      ],
      tip: 'If this version differs from what you deployed, the container did not restart onto the new image.',
    },
    ro: {
      title: 'Despre', icon: 'fa-circle-info',
      intro: 'Versiune, licenta si informatii de build pentru aceasta instalare.',
      sections: [
        { icon: 'fa-tag', title: 'Versiune', body: 'Versiunea care ruleaza — asta trebuie citata intr-un raport de bug, nu versiunea pe care ai deploiat-o.' },
        { icon: 'fa-scale-balanced', title: 'Licenta si credite', body: 'Termenii de licenta si componentele open-source de care depinde acest build.' },
      ],
      tip: 'Daca versiunea de aici difera de ce ai deploiat, containerul nu a repornit pe imaginea noua.',
    },
  },

  'whatsnew': {
    en: {
      title: "What's New", icon: 'fa-gift',
      intro: 'The release history of Docker Dash, newest first, with what changed in each version.',
      sections: [
        { icon: 'fa-list', title: 'Reading it', body: 'Entries are tagged as feature, improvement, fix or security so you can scan for what matters to you.' },
        { icon: 'fa-shield', title: 'Security entries', body: 'Anything tagged security changed a boundary, a default or a permission. Read those before upgrading.' },
      ],
      tip: 'The full technical changelog lives in CHANGELOG.md in the repository; this page is the readable summary.',
    },
    ro: {
      title: 'Noutati', icon: 'fa-gift',
      intro: 'Istoricul versiunilor Docker Dash, cele mai noi primele, cu ce s-a schimbat in fiecare.',
      sections: [
        { icon: 'fa-list', title: 'Cum se citeste', body: 'Intrarile sunt etichetate ca feature, imbunatatire, fix sau securitate, ca sa scanezi rapid ce te intereseaza.' },
        { icon: 'fa-shield', title: 'Intrari de securitate', body: 'Orice etichetat securitate a schimbat o limita, un default sau o permisiune. Citeste-le inainte de upgrade.' },
      ],
      tip: 'Changelog-ul tehnic complet e in CHANGELOG.md din repository; pagina asta e rezumatul lizibil.',
    },
  },

  'git-stacks': {
    en: {
      title: 'Git Stacks', icon: 'fa-code-branch',
      intro: 'Compose stacks whose definition lives in a Git repository rather than on the host.',
      sections: [
        { icon: 'fa-rotate', title: 'Sync', body: 'Pull the repository and deploy what the tracked branch says. Git is the source of truth, not the host filesystem.' },
        { icon: 'fa-triangle-exclamation', title: 'Drift', body: 'When the running stack no longer matches the committed definition, the difference is reported rather than silently overwritten.' },
        { icon: 'fa-key', title: 'Credentials', body: 'Repository credentials are encrypted at rest and never appear in deployment logs.' },
      ],
      tip: 'Drift usually means someone edited on the host. Fix it in Git, then sync — otherwise it comes straight back.',
    },
    ro: {
      title: 'Stack-uri Git', icon: 'fa-code-branch',
      intro: 'Stack-uri Compose a caror definitie sta intr-un repository Git, nu pe host.',
      sections: [
        { icon: 'fa-rotate', title: 'Sincronizare', body: 'Trage repository-ul si deployeaza ce spune branch-ul urmarit. Git e sursa de adevar, nu filesystem-ul hostului.' },
        { icon: 'fa-triangle-exclamation', title: 'Derapaj', body: 'Cand stack-ul care ruleaza nu mai corespunde definitiei comise, diferenta e raportata, nu suprascrisa tacit.' },
        { icon: 'fa-key', title: 'Credentiale', body: 'Credentialele de repository sunt criptate la repaus si nu apar niciodata in logurile de deploy.' },
      ],
      tip: 'Derapajul inseamna de obicei ca cineva a editat pe host. Corecteaza in Git, apoi sincronizeaza — altfel revine imediat.',
    },
  },

  'compare': {
    en: {
      title: 'Feature Comparison', icon: 'fa-table-columns',
      intro: 'How Docker Dash compares against other container management tools, feature by feature.',
      sections: [
        { icon: 'fa-check-double', title: 'Reading the matrix', body: 'Each row is a capability; the marks say whether it exists, partially exists, or is deliberately absent.' },
        { icon: 'fa-circle-question', title: 'Deliberate gaps', body: 'Some absences are choices, not omissions. Where that is the case the reasoning is stated.' },
      ],
      tip: 'Use this to decide whether a missing capability is on the roadmap or out of scope by design.',
    },
    ro: {
      title: 'Comparatie functionalitati', icon: 'fa-table-columns',
      intro: 'Cum se compara Docker Dash cu alte unelte de management de containere, functionalitate cu functionalitate.',
      sections: [
        { icon: 'fa-check-double', title: 'Cum se citeste', body: 'Fiecare rand e o capabilitate; marcajele spun daca exista, exista partial sau lipseste deliberat.' },
        { icon: 'fa-circle-question', title: 'Absente deliberate', body: 'Unele lipsuri sunt alegeri, nu omisiuni. Acolo unde e cazul, motivul e scris.' },
      ],
      tip: 'Foloseste pagina ca sa decizi daca o capabilitate lipsa e pe roadmap sau e in afara scopului prin design.',
    },
  },

  'insights': {
    en: {
      title: 'Insights', icon: 'fa-lightbulb',
      intro: 'Derived observations about your estate — patterns worth acting on, drawn from data already collected.',
      sections: [
        { icon: 'fa-chart-line', title: 'What it looks at', body: 'Resource trends, restart patterns, image age and configuration outliers across the hosts you have connected.' },
        { icon: 'fa-face-smile', title: 'A quiet page is good', body: 'No insights means nothing stood out. The page does not invent findings to look busy.' },
      ],
      tip: 'Insights describe correlation, not causation. Treat each one as a lead to check, not a verdict.',
    },
    ro: {
      title: 'Insights', icon: 'fa-lightbulb',
      intro: 'Observatii derivate despre parcul tau — tipare pe care merita sa actionezi, extrase din datele deja colectate.',
      sections: [
        { icon: 'fa-chart-line', title: 'Ce urmareste', body: 'Trenduri de resurse, tipare de restart, vechimea imaginilor si configuratii atipice pe hosturile conectate.' },
        { icon: 'fa-face-smile', title: 'O pagina goala e un semn bun', body: 'Lipsa observatiilor inseamna ca nimic nu a iesit in evidenta. Pagina nu inventeaza constatari ca sa para ocupata.' },
      ],
      tip: 'Insights descriu corelatie, nu cauzalitate. Trateaza fiecare ca pe o pista de verificat, nu ca pe un verdict.',
    },
  },

  'cost-optimizer': {
    en: {
      title: 'Cost Optimizer', icon: 'fa-coins',
      intro: 'Attributes your monthly server cost across containers by actual resource consumption.',
      sections: [
        { icon: 'fa-sliders', title: 'Set the monthly cost', body: 'Enter what the server actually costs you. Every figure on the page is a share of that number.' },
        { icon: 'fa-chart-pie', title: 'Attribution', body: 'Cost is split by measured CPU and memory usage, so idle containers show as cheap and busy ones as expensive.' },
        { icon: 'fa-scissors', title: 'Savings', body: 'Over-provisioned and long-idle workloads are called out as candidates to shrink or stop.' },
      ],
      tip: 'These are estimates from your own number, not billing data. They rank waste; they do not reconcile an invoice.',
    },
    ro: {
      title: 'Optimizator costuri', icon: 'fa-coins',
      intro: 'Distribuie costul lunar al serverului pe containere, dupa consumul real de resurse.',
      sections: [
        { icon: 'fa-sliders', title: 'Seteaza costul lunar', body: 'Introdu cat te costa efectiv serverul. Toate cifrele din pagina sunt o cota din acel numar.' },
        { icon: 'fa-chart-pie', title: 'Atribuire', body: 'Costul se imparte dupa CPU si memorie masurate, deci containerele inactive apar ieftine, iar cele incarcate scumpe.' },
        { icon: 'fa-scissors', title: 'Economii', body: 'Workload-urile supradimensionate sau inactive de mult sunt semnalate ca fiind candidate la reducere sau oprire.' },
      ],
      tip: 'Sunt estimari din numarul introdus de tine, nu date de facturare. Ordoneaza risipa; nu reconciliaza o factura.',
    },
  },

  'dependency-map': {
    en: {
      title: 'Dependency Map', icon: 'fa-diagram-project',
      intro: 'A visual graph of how your containers depend on each other through networks, links and Compose relationships.',
      sections: [
        { icon: 'fa-filter', title: 'Filtering', body: 'Narrow to running containers or to those that actually have dependencies, so the graph stays readable.' },
        { icon: 'fa-magnifying-glass', title: 'Navigating', body: 'Zoom and fit-all keep large estates workable. Click a node to jump to that container.' },
        { icon: 'fa-triangle-exclamation', title: 'What it reveals', body: 'Isolated nodes and unexpected edges are usually the interesting part — they show coupling nobody documented.' },
      ],
      tip: 'Check this before stopping anything. The map shows who breaks when you do.',
    },
    ro: {
      title: 'Harta dependintelor', icon: 'fa-diagram-project',
      intro: 'Un graf vizual al felului in care containerele depind unele de altele prin retele, link-uri si relatii Compose.',
      sections: [
        { icon: 'fa-filter', title: 'Filtrare', body: 'Restrange la containerele care ruleaza sau la cele care chiar au dependinte, ca graful sa ramana lizibil.' },
        { icon: 'fa-magnifying-glass', title: 'Navigare', body: 'Zoom si incadrare completa fac utilizabile parcurile mari. Click pe un nod te duce la containerul respectiv.' },
        { icon: 'fa-triangle-exclamation', title: 'Ce dezvaluie', body: 'Nodurile izolate si muchiile neasteptate sunt de obicei partea interesanta — arata cuplaje pe care nu le-a documentat nimeni.' },
      ],
      tip: 'Verifica harta inainte sa opresti ceva. Iti arata cine se strica atunci cand o faci.',
    },
  },

  'profile': {
    en: {
      title: 'My Profile', icon: 'fa-user',
      intro: 'Your own account — the identity you act as, the role that decides what you may do, and your password.',
      sections: [
        { icon: 'fa-id-card', title: 'Account information', body: 'Your username, role and user ID. The role determines what you can do everywhere else in the application.' },
        { icon: 'fa-key', title: 'Changing your password', body: 'Requires your current password. Changing it does not sign out your other sessions automatically.' },
      ],
      tip: 'If your role looks wrong, an administrator has to change it — it is not editable from here.',
    },
    ro: {
      title: 'Profilul meu', icon: 'fa-user',
      intro: 'Contul tau — identitatea sub care actionezi, rolul care decide ce ai voie sa faci, si parola.',
      sections: [
        { icon: 'fa-id-card', title: 'Informatii cont', body: 'Numele de utilizator, rolul si ID-ul. Rolul determina ce poti face in restul aplicatiei.' },
        { icon: 'fa-key', title: 'Schimbarea parolei', body: 'Necesita parola curenta. Schimbarea ei nu iti deconecteaza automat celelalte sesiuni.' },
      ],
      tip: 'Daca rolul pare gresit, trebuie schimbat de un administrator — nu e editabil de aici.',
    },
  },

  'notifications': {
    en: {
      title: 'Notifications', icon: 'fa-bell',
      intro: 'Everything the system wanted to tell you, in one list.',
      sections: [
        { icon: 'fa-envelope-open', title: 'Read state', body: 'Mark items read individually or all at once. Read state is per user, not global.' },
        { icon: 'fa-share-nodes', title: 'Delivery channels', body: 'Where notifications are also sent — email, webhooks, chat — is configured under Settings, not here.' },
      ],
      tip: 'An empty list means nothing was raised, not that delivery is broken. Test a channel from Settings to be sure.',
    },
    ro: {
      title: 'Notificari', icon: 'fa-bell',
      intro: 'Tot ce a vrut sistemul sa iti spuna, intr-o singura lista.',
      sections: [
        { icon: 'fa-envelope-open', title: 'Starea de citire', body: 'Marcheaza elementele citite individual sau pe toate odata. Starea e per utilizator, nu globala.' },
        { icon: 'fa-share-nodes', title: 'Canale de livrare', body: 'Unde se trimit notificarile in plus — email, webhook-uri, chat — se configureaza in Setari, nu aici.' },
      ],
      tip: 'O lista goala inseamna ca nu s-a ridicat nimic, nu ca livrarea e stricata. Testeaza un canal din Setari ca sa fii sigur.',
    },
  },

  'stacks': {
    en: {
      title: 'Stacks', icon: 'fa-layer-group',
      intro: 'Compose stacks and Git-linked deployments in one place, whatever their source.',
      sections: [
        { icon: 'fa-folder-tree', title: 'Sources', body: 'The tabs separate Compose stacks defined on the host from stacks tracked in Git. The All tab shows both.' },
        { icon: 'fa-magnifying-glass', title: 'Search', body: 'One query matches stack names, services, containers, images, status, repositories, branches and commits, without refetching.' },
        { icon: 'fa-play', title: 'Actions', body: 'Up, down, restart and pull act on the whole stack. Each is confirmed first and recorded in the audit log.' },
      ],
      tip: 'An empty result after typing means no match — an empty host looks different and says so.',
    },
    ro: {
      title: 'Stack-uri', icon: 'fa-layer-group',
      intro: 'Stack-uri Compose si deploy-uri legate de Git in acelasi loc, indiferent de sursa.',
      sections: [
        { icon: 'fa-folder-tree', title: 'Surse', body: 'Tab-urile separa stack-urile Compose definite pe host de cele urmarite in Git. Tab-ul All le arata pe ambele.' },
        { icon: 'fa-magnifying-glass', title: 'Cautare', body: 'O singura interogare cauta in nume, servicii, containere, imagini, status, repository-uri, branch-uri si commit-uri, fara refetch.' },
        { icon: 'fa-play', title: 'Actiuni', body: 'Up, down, restart si pull actioneaza asupra intregului stack. Fiecare se confirma intai si se inregistreaza in audit.' },
      ],
      tip: 'Un rezultat gol dupa ce ai tastat inseamna ca nu exista potrivire — un host gol arata altfel si o spune explicit.',
    },
  },

  'compose-catalog': {
    en: {
      title: 'Compose Catalog', icon: 'fa-book',
      intro: 'Curated application blueprints with an owner, a support level and immutable versions pinned to image digests.',
      sections: [
        { icon: 'fa-signature', title: 'Signed and pinned', body: 'Publishing requires Cosign verification against an explicit signer identity, and every version resolves to a SHA-256 digest rather than a moving tag.' },
        { icon: 'fa-keyboard', title: 'Typed parameters', body: 'A wizard collects typed inputs. Secret values must be references — inline secret material is rejected before anything is stored.' },
        { icon: 'fa-eye', title: 'Preview and diff', body: 'Preview the exact result and compare versions before instantiating. Plans that have gone stale are refused rather than applied.' },
        { icon: 'fa-hand', title: 'Does not deploy', body: 'Instantiating creates a stopped definition. Starting it is a separate, explicitly confirmed step.' },
      ],
      tip: 'A catalog entry can never silently start or change a running workload — that separation is the point.',
    },
    ro: {
      title: 'Catalog Compose', icon: 'fa-book',
      intro: 'Blueprint-uri de aplicatii curatate, cu proprietar, nivel de suport si versiuni imuabile fixate pe digest-uri de imagine.',
      sections: [
        { icon: 'fa-signature', title: 'Semnat si fixat', body: 'Publicarea cere verificare Cosign fata de o identitate de semnatar explicita, iar fiecare versiune se rezolva la un digest SHA-256, nu la un tag mobil.' },
        { icon: 'fa-keyboard', title: 'Parametri tipati', body: 'Un wizard colecteaza intrari tipate. Valorile secrete trebuie sa fie referinte — materialul secret inline e respins inainte de stocare.' },
        { icon: 'fa-eye', title: 'Previzualizare si diff', body: 'Vezi rezultatul exact si compara versiuni inainte de instantiere. Planurile invechite sunt refuzate, nu aplicate.' },
        { icon: 'fa-hand', title: 'Nu deployeaza', body: 'Instantierea creeaza o definitie oprita. Pornirea ei e un pas separat, confirmat explicit.' },
      ],
      tip: 'O intrare din catalog nu poate porni sau schimba tacit un workload care ruleaza — exact asta e ideea separarii.',
    },
  },

  'swarm': {
    en: {
      title: 'Docker Swarm', icon: 'fa-network-wired',
      intro: 'Swarm cluster state: nodes, services and the tasks scheduled onto them.',
      sections: [
        { icon: 'fa-sitemap', title: 'Nodes', body: 'Managers and workers with availability and reachability. A manager that is down is a quorum problem, not just a missing node.' },
        { icon: 'fa-cubes', title: 'Services and tasks', body: 'Desired versus running replicas per service, and the individual tasks behind them.' },
      ],
      tip: 'Replicas stuck below the desired count usually mean a constraint no node satisfies, not a crash.',
    },
    ro: {
      title: 'Docker Swarm', icon: 'fa-network-wired',
      intro: 'Starea clusterului Swarm: noduri, servicii si task-urile programate pe ele.',
      sections: [
        { icon: 'fa-sitemap', title: 'Noduri', body: 'Manageri si workeri cu disponibilitate si accesibilitate. Un manager cazut e o problema de cvorum, nu doar un nod lipsa.' },
        { icon: 'fa-cubes', title: 'Servicii si task-uri', body: 'Replici dorite fata de replici active per serviciu, si task-urile individuale din spate.' },
      ],
      tip: 'Replicile blocate sub numarul dorit inseamna de obicei o constrangere pe care niciun nod nu o satisface, nu un crash.',
    },
  },

  'incus-instances': {
    en: {
      title: 'Incus / LXD instances', icon: 'fa-box',
      intro: 'System containers and virtual machines managed by an Incus or LXD endpoint.',
      sections: [
        { icon: 'fa-list', title: 'Instances', body: 'Both container and VM instance types are listed with state, type and the project they belong to.' },
        { icon: 'fa-power-off', title: 'Lifecycle', body: 'Start, stop and restart are audited. Destructive actions require confirmation.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'This integration is marked alpha: the read paths are solid, the write paths are still narrowing.' },
      ],
      tip: 'Incus instances are not Docker containers — their images, networking and storage are managed by Incus, not by the Docker daemon.',
    },
    ro: {
      title: 'Instante Incus / LXD', icon: 'fa-box',
      intro: 'Containere de sistem si masini virtuale gestionate de un endpoint Incus sau LXD.',
      sections: [
        { icon: 'fa-list', title: 'Instante', body: 'Sunt listate ambele tipuri, container si VM, cu stare, tip si proiectul din care fac parte.' },
        { icon: 'fa-power-off', title: 'Ciclu de viata', body: 'Start, stop si restart sunt auditate. Actiunile distructive cer confirmare.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Integrarea e marcata alpha: caile de citire sunt solide, cele de scriere inca se restrang.' },
      ],
      tip: 'Instantele Incus nu sunt containere Docker — imaginile, reteaua si stocarea lor sunt gestionate de Incus, nu de daemonul Docker.',
    },
  },

  'proxmox-resources': {
    en: {
      title: 'Proxmox VE', icon: 'fa-server',
      intro: 'Nodes, QEMU virtual machines and LXC containers from a Proxmox VE cluster.',
      sections: [
        { icon: 'fa-sitemap', title: 'Inventory', body: 'Read-only inventory across the cluster, grouped by node, with state and resource allocation.' },
        { icon: 'fa-lock', title: 'Credentials', body: 'API token ID and secret are encrypted at rest. Disabling TLS verification is reported as a posture finding.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marked alpha: expect inventory and read paths to be reliable before write operations are.' },
      ],
      tip: 'Use an API token scoped to what you actually need rather than root@pam — the token is what this stores.',
    },
    ro: {
      title: 'Proxmox VE', icon: 'fa-server',
      intro: 'Noduri, masini virtuale QEMU si containere LXC dintr-un cluster Proxmox VE.',
      sections: [
        { icon: 'fa-sitemap', title: 'Inventar', body: 'Inventar read-only pe tot clusterul, grupat pe noduri, cu stare si alocare de resurse.' },
        { icon: 'fa-lock', title: 'Credentiale', body: 'ID-ul si secretul token-ului API sunt criptate la repaus. Dezactivarea verificarii TLS apare ca o constatare de postura.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marcat alpha: inventarul si citirile sunt fiabile inaintea operatiilor de scriere.' },
      ],
      tip: 'Foloseste un token API limitat la ce ai nevoie, nu root@pam — token-ul e ce se stocheaza aici.',
    },
  },

  'migration-vm': {
    en: {
      title: 'VM Migration', icon: 'fa-right-left',
      intro: 'Plan and track moving virtual machines between virtualization platforms.',
      sections: [
        { icon: 'fa-clipboard-check', title: 'Plan first', body: 'A migration is planned and reviewed before anything moves. The plan states exactly what will be created where.' },
        { icon: 'fa-list-check', title: 'Compatibility', body: 'Guest OS, disk format and hardware differences between source and target are surfaced up front rather than discovered mid-move.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marked alpha. Treat every migration as one you must be able to roll back.' },
      ],
      tip: 'Take a snapshot or backup of the source before migrating. A migration is not a backup.',
    },
    ro: {
      title: 'Migrare VM', icon: 'fa-right-left',
      intro: 'Planifica si urmareste mutarea masinilor virtuale intre platforme de virtualizare.',
      sections: [
        { icon: 'fa-clipboard-check', title: 'Intai planul', body: 'O migrare e planificata si revizuita inainte sa se mute ceva. Planul spune exact ce se creeaza si unde.' },
        { icon: 'fa-list-check', title: 'Compatibilitate', body: 'Diferentele de OS guest, format de disc si hardware intre sursa si destinatie apar din start, nu la mijlocul mutarii.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marcat alpha. Trateaza fiecare migrare ca pe una pe care trebuie sa o poti da inapoi.' },
      ],
      tip: 'Fa un snapshot sau un backup al sursei inainte de migrare. O migrare nu e un backup.',
    },
  },

  'kubernetes-resources': {
    en: {
      title: 'Kubernetes resources', icon: 'fa-dharmachakra',
      intro: 'Workloads and cluster objects from a connected Kubernetes cluster.',
      sections: [
        { icon: 'fa-cubes', title: 'Workloads', body: 'Deployments, pods and their status by namespace, with desired versus ready replicas.' },
        { icon: 'fa-key', title: 'Access', body: 'Access uses the kubeconfig or service-account credentials you supplied; Docker Dash cannot see more than that identity can.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marked alpha and read-oriented. This is not a replacement for kubectl.' },
      ],
      tip: 'A pod that is Running is not necessarily Ready. Check readiness before concluding a rollout succeeded.',
    },
    ro: {
      title: 'Resurse Kubernetes', icon: 'fa-dharmachakra',
      intro: 'Workload-uri si obiecte dintr-un cluster Kubernetes conectat.',
      sections: [
        { icon: 'fa-cubes', title: 'Workload-uri', body: 'Deployment-uri, pod-uri si starea lor pe namespace, cu replici dorite fata de replici gata.' },
        { icon: 'fa-key', title: 'Acces', body: 'Accesul foloseste kubeconfig-ul sau contul de serviciu pe care l-ai furnizat; Docker Dash nu vede mai mult decat vede acea identitate.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marcat alpha si orientat spre citire. Nu inlocuieste kubectl.' },
      ],
      tip: 'Un pod in stare Running nu e neaparat Ready. Verifica readiness inainte sa concluzionezi ca rollout-ul a reusit.',
    },
  },

  'nomad-jobs': {
    en: {
      title: 'Nomad workloads', icon: 'fa-cubes',
      intro: 'Jobs, task groups and allocations from a connected HashiCorp Nomad cluster.',
      sections: [
        { icon: 'fa-briefcase', title: 'Jobs and allocations', body: 'Each job lists its groups and the allocations actually placed on client nodes.' },
        { icon: 'fa-triangle-exclamation', title: 'Failed placements', body: 'An allocation that cannot be placed is usually a constraint or resource shortfall, and is shown as such.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marked alpha and read-oriented.' },
      ],
      tip: 'A job can be healthy while its allocations are not. Read the allocation level before trusting the job status.',
    },
    ro: {
      title: 'Workload-uri Nomad', icon: 'fa-cubes',
      intro: 'Job-uri, grupuri de task-uri si alocari dintr-un cluster HashiCorp Nomad conectat.',
      sections: [
        { icon: 'fa-briefcase', title: 'Job-uri si alocari', body: 'Fiecare job isi listeaza grupurile si alocarile plasate efectiv pe nodurile client.' },
        { icon: 'fa-triangle-exclamation', title: 'Plasari esuate', body: 'O alocare care nu poate fi plasata e de obicei o constrangere sau o lipsa de resurse, si e aratata ca atare.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marcat alpha si orientat spre citire.' },
      ],
      tip: 'Un job poate parea sanatos in timp ce alocarile lui nu sunt. Citeste nivelul de alocare inainte sa te bazezi pe statusul job-ului.',
    },
  },

  'vsphere-resources': {
    en: {
      title: 'VMware vSphere / ESXi', icon: 'fa-server',
      intro: 'Hosts, virtual machines and their resource usage from a vCenter or standalone ESXi endpoint.',
      sections: [
        { icon: 'fa-server', title: 'Hosts', body: 'CPU and memory per ESXi host, with core and thread counts, product version and uptime.' },
        { icon: 'fa-desktop', title: 'Virtual machines', body: 'Power state, vCPU and memory allocation, and guest OS per VM.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marked alpha. Inventory and metrics are read-only here.' },
      ],
      tip: 'Allocated is not used. A VM with 16 vCPU allocated may be idle — check the host figures for real pressure.',
    },
    ro: {
      title: 'VMware vSphere / ESXi', icon: 'fa-server',
      intro: 'Hosturi, masini virtuale si consumul lor de resurse dintr-un endpoint vCenter sau ESXi standalone.',
      sections: [
        { icon: 'fa-server', title: 'Hosturi', body: 'CPU si memorie per host ESXi, cu numar de nuclee si fire, versiune de produs si uptime.' },
        { icon: 'fa-desktop', title: 'Masini virtuale', body: 'Stare de alimentare, alocare de vCPU si memorie, si sistemul de operare guest per VM.' },
        { icon: 'fa-flask', title: 'Alpha', body: 'Marcat alpha. Inventarul si metricile sunt read-only aici.' },
      ],
      tip: 'Alocat nu inseamna folosit. Un VM cu 16 vCPU alocate poate fi inactiv — uita-te la cifrele hostului pentru presiunea reala.',
    },
  },

  'xen-resources': {
    en: {
      title: 'Xen / XCP-ng', icon: 'fa-server',
      intro: 'Hosts, pools and virtual machines from a XenServer or XCP-ng pool.',
      sections: [
        { icon: 'fa-sitemap', title: 'Pool and hosts', body: 'Pool membership and per-host resources. The pool master is the endpoint that answers for the whole pool.' },
        { icon: 'fa-desktop', title: 'Virtual machines', body: 'Power state and resource allocation per VM, including templates and control domains where relevant.' },
      ],
      tip: 'If the pool master is unreachable the whole pool looks down — check the master before assuming a wider outage.',
    },
    ro: {
      title: 'Xen / XCP-ng', icon: 'fa-server',
      intro: 'Hosturi, pool-uri si masini virtuale dintr-un pool XenServer sau XCP-ng.',
      sections: [
        { icon: 'fa-sitemap', title: 'Pool si hosturi', body: 'Apartenenta la pool si resursele per host. Pool master-ul e endpoint-ul care raspunde pentru tot pool-ul.' },
        { icon: 'fa-desktop', title: 'Masini virtuale', body: 'Stare de alimentare si alocare de resurse per VM, inclusiv template-uri si domenii de control unde e cazul.' },
      ],
      tip: 'Daca pool master-ul e inaccesibil, tot pool-ul pare cazut — verifica master-ul inainte sa presupui o pana mai larga.',
    },
  },

  'virtual-machines': {
    en: {
      title: 'Virtual Machines', icon: 'fa-desktop',
      intro: 'Every virtual machine across every connected provider, in one list.',
      sections: [
        { icon: 'fa-layer-group', title: 'One view, many providers', body: 'Proxmox, vSphere, Xen and Incus VMs appear side by side with a common vocabulary for state and resources.' },
        { icon: 'fa-power-off', title: 'Power and snapshots', body: 'Lifecycle actions are provider-specific underneath but confirmed and audited the same way everywhere.' },
        { icon: 'fa-shield', title: 'Guarded operations', body: 'Forced power-off, snapshot revert and delete are treated as critical and may require an elevated, time-limited grant.' },
      ],
      tip: 'Snapshot revert discards everything since the snapshot. It is the fastest way to lose a day of data.',
    },
    ro: {
      title: 'Masini virtuale', icon: 'fa-desktop',
      intro: 'Toate masinile virtuale de la toti providerii conectati, intr-o singura lista.',
      sections: [
        { icon: 'fa-layer-group', title: 'O vedere, mai multi provideri', body: 'VM-uri Proxmox, vSphere, Xen si Incus apar alaturat, cu un vocabular comun pentru stare si resurse.' },
        { icon: 'fa-power-off', title: 'Alimentare si snapshot-uri', body: 'Actiunile de ciclu de viata sunt specifice providerului dedesubt, dar confirmate si auditate la fel peste tot.' },
        { icon: 'fa-shield', title: 'Operatii protejate', body: 'Oprirea fortata, revenirea la snapshot si stergerea sunt tratate ca fiind critice si pot cere un drept elevat, limitat in timp.' },
      ],
      tip: 'Revenirea la snapshot arunca tot ce s-a intamplat de la snapshot incoace. E cea mai rapida cale de a pierde o zi de date.',
    },
  },

  'high-availability': {
    en: {
      title: 'High Availability', icon: 'fa-tower-broadcast',
      intro: 'The state of HA mode: which node is leader, who else is in the cluster, and how healthy the coordination is.',
      sections: [
        { icon: 'fa-crown', title: 'Leader election', body: 'Exactly one node holds leadership and runs scheduled work. The others stand by and serve reads.' },
        { icon: 'fa-database', title: 'Redis-backed', body: 'HA mode is opt-in and requires Redis for coordination. In standalone mode this page reports a single node and nothing to elect.' },
        { icon: 'fa-heart-pulse', title: 'Failover', body: 'If the leader stops renewing its lease another node takes over. Brief overlap is expected; permanent split is not.' },
      ],
      tip: 'Background jobs run on the leader only. If scheduled work stops, check who holds leadership before checking the jobs.',
    },
    ro: {
      title: 'Inalta disponibilitate', icon: 'fa-tower-broadcast',
      intro: 'Starea modului HA: care nod e lider, cine mai e in cluster si cat de sanatoasa e coordonarea.',
      sections: [
        { icon: 'fa-crown', title: 'Alegerea liderului', body: 'Exact un nod detine conducerea si ruleaza munca programata. Celelalte stau in asteptare si servesc citiri.' },
        { icon: 'fa-database', title: 'Bazat pe Redis', body: 'Modul HA e optional si necesita Redis pentru coordonare. In mod standalone pagina raporteaza un singur nod si nimic de ales.' },
        { icon: 'fa-heart-pulse', title: 'Failover', body: 'Daca liderul nu isi mai reinnoieste lease-ul, alt nod preia. O suprapunere scurta e normala; una permanenta nu.' },
      ],
      tip: 'Job-urile de fundal ruleaza doar pe lider. Daca munca programata se opreste, verifica intai cine e lider.',
    },
  },

  'storage-posture': {
    en: {
      title: 'Storage Posture', icon: 'fa-hard-drive',
      intro: 'Storage-side risks across your providers: capacity headroom, redundancy and datastore health.',
      sections: [
        { icon: 'fa-gauge', title: 'Capacity', body: 'Datastores approaching full are flagged early, because storage that fills up takes workloads down with it.' },
        { icon: 'fa-copy', title: 'Redundancy', body: 'Single points of failure in the storage path are called out rather than assumed acceptable.' },
      ],
      tip: 'Free space is not headroom. A datastore at 85% with thin-provisioned VMs can still overcommit.',
    },
    ro: {
      title: 'Postura de stocare', icon: 'fa-hard-drive',
      intro: 'Riscuri de stocare la nivelul providerilor: rezerva de capacitate, redundanta si sanatatea datastore-urilor.',
      sections: [
        { icon: 'fa-gauge', title: 'Capacitate', body: 'Datastore-urile aproape pline sunt semnalate din timp, pentru ca stocarea plina duce workload-urile cu ea.' },
        { icon: 'fa-copy', title: 'Redundanta', body: 'Punctele unice de esec din calea de stocare sunt semnalate, nu presupuse acceptabile.' },
      ],
      tip: 'Spatiul liber nu e rezerva. Un datastore la 85% cu VM-uri thin-provisioned poate inca sa supraaloce.',
    },
  },

  'network-posture': {
    en: {
      title: 'Network Posture', icon: 'fa-network-wired',
      intro: 'Network-side risks across your providers: reachability, segmentation and exposure.',
      sections: [
        { icon: 'fa-route', title: 'Reachability', body: 'Whether the paths your workloads depend on actually work, assessed rather than assumed.' },
        { icon: 'fa-object-group', title: 'Segmentation', body: 'Flat networks and overly permissive paths between segments are surfaced as findings.' },
      ],
      tip: 'A working path is not a safe one. Reachable and intended are different questions.',
    },
    ro: {
      title: 'Postura de retea', icon: 'fa-network-wired',
      intro: 'Riscuri de retea la nivelul providerilor: accesibilitate, segmentare si expunere.',
      sections: [
        { icon: 'fa-route', title: 'Accesibilitate', body: 'Daca traseele de care depind workload-urile chiar functioneaza — evaluat, nu presupus.' },
        { icon: 'fa-object-group', title: 'Segmentare', body: 'Retelele plate si traseele prea permisive intre segmente apar ca si constatari.' },
      ],
      tip: 'Un traseu functional nu e unul sigur. Accesibil si intentionat sunt intrebari diferite.',
    },
  },

  'provider-security-posture': {
    en: {
      title: 'Provider Security', icon: 'fa-user-shield',
      intro: 'Security posture of the virtualization providers themselves, not of the workloads on them.',
      sections: [
        { icon: 'fa-certificate', title: 'Transport and certificates', body: 'TLS verification, certificate trust and expiry for every provider endpoint you have registered.' },
        { icon: 'fa-user-lock', title: 'Identity and credentials', body: 'How each provider is authenticated, and whether the credential is scoped or effectively administrative.' },
        { icon: 'fa-clipboard-check', title: 'Hardening', body: 'Provider-side hardening evidence is reported as it is collected, without inferring what was not checked.' },
      ],
      tip: 'Disabling TLS verification to make a connection work turns an encrypted channel into an unauthenticated one.',
    },
    ro: {
      title: 'Securitatea providerilor', icon: 'fa-user-shield',
      intro: 'Postura de securitate a providerilor de virtualizare in sine, nu a workload-urilor de pe ei.',
      sections: [
        { icon: 'fa-certificate', title: 'Transport si certificate', body: 'Verificare TLS, incredere in certificate si expirare pentru fiecare endpoint de provider inregistrat.' },
        { icon: 'fa-user-lock', title: 'Identitate si credentiale', body: 'Cum e autentificat fiecare provider si daca acel credential e limitat sau efectiv administrativ.' },
        { icon: 'fa-clipboard-check', title: 'Hardening', body: 'Dovezile de hardening de partea providerului sunt raportate asa cum sunt colectate, fara a deduce ce nu a fost verificat.' },
      ],
      tip: 'Dezactivarea verificarii TLS ca sa mearga conexiunea transforma un canal criptat intr-unul neautentificat.',
    },
  },

  'placement-advisor': {
    en: {
      title: 'Placement Advisor', icon: 'fa-map-location-dot',
      intro: 'Suggests where a new workload should go, based on current capacity and constraints across your hosts.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'How it decides', body: 'Available CPU, memory and existing load are weighed against what the workload asks for.' },
        { icon: 'fa-hand', title: 'Advice, not action', body: 'The advisor ranks candidates. Placing the workload remains a deliberate step you take.' },
      ],
      tip: 'The advisor sees capacity, not your intent. Affinity, licensing and blast-radius decisions are still yours.',
    },
    ro: {
      title: 'Consilier de plasare', icon: 'fa-map-location-dot',
      intro: 'Sugereaza unde ar trebui sa mearga un workload nou, pe baza capacitatii curente si a constrangerilor de pe hosturi.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'Cum decide', body: 'CPU-ul disponibil, memoria si incarcarea existenta sunt cantarite fata de ce cere workload-ul.' },
        { icon: 'fa-hand', title: 'Sfat, nu actiune', body: 'Consilierul ordoneaza candidatii. Plasarea efectiva ramane un pas deliberat facut de tine.' },
      ],
      tip: 'Consilierul vede capacitatea, nu intentia ta. Afinitatea, licentierea si raza de impact raman decizii ale tale.',
    },
  },

  'recovery-points': {
    en: {
      title: 'Recovery Points', icon: 'fa-clock-rotate-left',
      intro: 'The restore points you actually have, and drills that prove they work.',
      sections: [
        { icon: 'fa-list', title: 'Points', body: 'Available recovery points per protected workload, with age and where they live.' },
        { icon: 'fa-vial', title: 'Restore drills', body: 'A drill restores for real and reports the outcome. An untested backup is a hope, not a recovery plan.' },
      ],
      tip: 'The number that matters is time since the last successful drill, not the number of backups you hold.',
    },
    ro: {
      title: 'Puncte de recuperare', icon: 'fa-clock-rotate-left',
      intro: 'Punctele de restaurare pe care le ai efectiv, si exercitiile care dovedesc ca functioneaza.',
      sections: [
        { icon: 'fa-list', title: 'Puncte', body: 'Punctele de recuperare disponibile per workload protejat, cu vechime si locul unde stau.' },
        { icon: 'fa-vial', title: 'Exercitii de restaurare', body: 'Un exercitiu restaureaza pe bune si raporteaza rezultatul. Un backup netestat e o speranta, nu un plan de recuperare.' },
      ],
      tip: 'Cifra care conteaza e timpul scurs de la ultimul exercitiu reusit, nu numarul de backup-uri pe care le detii.',
    },
  },

  'backup-policies': {
    en: {
      title: 'Backup Policies', icon: 'fa-shield-heart',
      intro: 'Rules that decide what gets backed up, how often, and how long copies are kept.',
      sections: [
        { icon: 'fa-calendar', title: 'Schedule and scope', body: 'A policy names the workloads it protects and when it runs. Anything outside every policy is unprotected.' },
        { icon: 'fa-trash-clock', title: 'Retention', body: 'Retention decides when old points are removed. Longer retention costs storage; shorter costs recoverability.' },
      ],
      tip: 'Check what no policy covers. Gaps are found during a restore, which is the worst time to find them.',
    },
    ro: {
      title: 'Politici de backup', icon: 'fa-shield-heart',
      intro: 'Reguli care decid ce se salveaza, cat de des si cat timp se pastreaza copiile.',
      sections: [
        { icon: 'fa-calendar', title: 'Program si scop', body: 'O politica numeste workload-urile pe care le protejeaza si cand ruleaza. Orice ramane in afara tuturor politicilor e neprotejat.' },
        { icon: 'fa-trash-clock', title: 'Retentie', body: 'Retentia decide cand dispar punctele vechi. Retentia lunga costa stocare; cea scurta costa recuperabilitate.' },
      ],
      tip: 'Verifica ce nu acopera nicio politica. Golurile se descopera la restaurare, adica in cel mai prost moment.',
    },
  },

  'disaster-recovery': {
    en: {
      title: 'Disaster Recovery', icon: 'fa-house-flood-water',
      intro: 'Protection groups and the plan for bringing them back somewhere else when a site is lost.',
      sections: [
        { icon: 'fa-object-group', title: 'Protection groups', body: 'Workloads that must fail over together belong in one group, because recovering half an application is not recovery.' },
        { icon: 'fa-diagram-project', title: 'Recovery plan', body: 'Order matters: the plan states what comes up first and what waits on it.' },
        { icon: 'fa-vial', title: 'Testing', body: 'A plan that has never been executed is an assumption. Test it before you need it.' },
      ],
      tip: 'Define groups by dependency, not by convenience. The database and the app that needs it belong together.',
    },
    ro: {
      title: 'Recuperare in caz de dezastru', icon: 'fa-house-flood-water',
      intro: 'Grupuri de protectie si planul de a le reporni in alta parte cand pierzi un site.',
      sections: [
        { icon: 'fa-object-group', title: 'Grupuri de protectie', body: 'Workload-urile care trebuie sa faca failover impreuna stau in acelasi grup — recuperarea a jumatate de aplicatie nu e recuperare.' },
        { icon: 'fa-diagram-project', title: 'Plan de recuperare', body: 'Ordinea conteaza: planul spune ce porneste primul si ce asteapta dupa el.' },
        { icon: 'fa-vial', title: 'Testare', body: 'Un plan care nu a fost executat niciodata e o presupunere. Testeaza-l inainte sa ai nevoie de el.' },
      ],
      tip: 'Defineste grupurile dupa dependinte, nu dupa comoditate. Baza de date si aplicatia care o foloseste stau impreuna.',
    },
  },

  'virtualization-catalog': {
    en: {
      title: 'VM Catalog', icon: 'fa-book-open',
      intro: 'Templates and images available for provisioning new virtual machines across your providers.',
      sections: [
        { icon: 'fa-clone', title: 'Templates', body: 'What each provider offers as a starting point, with the guest OS and sizing it implies.' },
        { icon: 'fa-wand-magic-sparkles', title: 'Provisioning', body: 'Creating from a catalog entry produces a defined VM; guest customization and power-on are separate, explicit steps.' },
      ],
      tip: 'A template is a starting point, not a policy. Hardening and patching still apply to whatever it produces.',
    },
    ro: {
      title: 'Catalog VM', icon: 'fa-book-open',
      intro: 'Template-uri si imagini disponibile pentru provisionarea de masini virtuale noi la providerii tai.',
      sections: [
        { icon: 'fa-clone', title: 'Template-uri', body: 'Ce ofera fiecare provider ca punct de plecare, cu sistemul guest si dimensionarea implicate.' },
        { icon: 'fa-wand-magic-sparkles', title: 'Provisionare', body: 'Crearea dintr-o intrare de catalog produce un VM definit; personalizarea guest si pornirea sunt pasi separati si expliciti.' },
      ],
      tip: 'Un template e un punct de plecare, nu o politica. Hardening-ul si patch-urile se aplica in continuare la ce produce.',
    },
  },

  'activity': {
    en: {
      title: 'Activity Center', icon: 'fa-wave-square',
      intro: 'Long-running operations and their progress, from queued through to finished or failed.',
      sections: [
        { icon: 'fa-spinner', title: 'In-flight work', body: 'Operations that are still running, with the step they are on rather than just a spinner.' },
        { icon: 'fa-clock-rotate-left', title: 'History', body: 'Completed and failed operations stay visible with their outcome, so a failure is not lost on refresh.' },
      ],
      tip: 'If an operation looks stuck, read its current step. A slow step and a hung one look identical from outside.',
    },
    ro: {
      title: 'Centru de activitate', icon: 'fa-wave-square',
      intro: 'Operatii de lunga durata si progresul lor, de la coada pana la finalizare sau esec.',
      sections: [
        { icon: 'fa-spinner', title: 'Lucru in desfasurare', body: 'Operatiile inca active, cu pasul la care se afla, nu doar cu un spinner.' },
        { icon: 'fa-clock-rotate-left', title: 'Istoric', body: 'Operatiile terminate si esuate raman vizibile cu rezultatul lor, deci un esec nu se pierde la refresh.' },
      ],
      tip: 'Daca o operatie pare blocata, citeste pasul curent. Un pas lent si unul agatat arata identic din afara.',
    },
  },

  'api-playground': {
    en: {
      title: 'API Playground', icon: 'fa-code',
      intro: 'Explore and call the Docker Dash HTTP API from inside the application, with your current session.',
      sections: [
        { icon: 'fa-list', title: 'Endpoints', body: 'Browse available endpoints with their methods and parameters instead of reading the source.' },
        { icon: 'fa-paper-plane', title: 'Calling', body: 'Requests run as you, with your role. A call you are not authorized for fails here exactly as it would anywhere else.' },
        { icon: 'fa-triangle-exclamation', title: 'These are real calls', body: 'A write endpoint invoked here changes real state and is audited like any other action.' },
      ],
      tip: 'Use it to learn the API before automating against it — the shapes here are the shapes your script will get.',
    },
    ro: {
      title: 'API Playground', icon: 'fa-code',
      intro: 'Exploreaza si apeleaza API-ul HTTP Docker Dash din interiorul aplicatiei, cu sesiunea ta curenta.',
      sections: [
        { icon: 'fa-list', title: 'Endpoint-uri', body: 'Rasfoieste endpoint-urile disponibile cu metodele si parametrii lor, in loc sa citesti sursa.' },
        { icon: 'fa-paper-plane', title: 'Apelare', body: 'Cererile ruleaza in numele tau, cu rolul tau. Un apel pentru care nu ai drepturi esueaza aici exact ca oriunde altundeva.' },
        { icon: 'fa-triangle-exclamation', title: 'Sunt apeluri reale', body: 'Un endpoint de scriere apelat aici schimba starea reala si e auditat ca orice alta actiune.' },
      ],
      tip: 'Foloseste-l ca sa inveti API-ul inainte sa automatizezi — formele de aici sunt formele pe care le va primi scriptul tau.',
    },
  },

  'logs': {
    en: {
      title: 'Log Explorer', icon: 'fa-scroll',
      intro: 'Search logs across containers without opening each one separately.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Searching', body: 'Filter by level and text, across a selection of containers at once, over a bounded time window.' },
        { icon: 'fa-download', title: 'Export', body: 'What you are looking at can be downloaded for an incident ticket or an offline read.' },
        { icon: 'fa-clock', title: 'Bounded by design', body: 'Queries are limited in range and volume so a search cannot flood the browser or the daemon.' },
      ],
      tip: 'Logs may contain secrets that applications printed. Redact before attaching an export to a ticket.',
    },
    ro: {
      title: 'Explorator de loguri', icon: 'fa-scroll',
      intro: 'Cauta in logurile mai multor containere fara sa le deschizi pe fiecare separat.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Cautare', body: 'Filtreaza dupa nivel si text, peste o selectie de containere deodata, intr-o fereastra de timp marginita.' },
        { icon: 'fa-download', title: 'Export', body: 'Ce vezi poate fi descarcat pentru un tichet de incident sau pentru citire offline.' },
        { icon: 'fa-clock', title: 'Marginit prin design', body: 'Interogarile sunt limitate ca interval si volum, ca o cautare sa nu inunde browserul sau daemonul.' },
      ],
      tip: 'Logurile pot contine secrete tiparite de aplicatii. Redacteaza inainte sa atasezi un export la un tichet.',
    },
  },

  'timeline': {
    en: {
      title: 'Event Timeline', icon: 'fa-stream',
      intro: 'What happened across the estate, in order, with the categories separated.',
      sections: [
        { icon: 'fa-filter', title: 'Categories', body: 'Deployments, lifecycle, actions, alerts, auth and security events can be read together or one at a time.' },
        { icon: 'fa-clock', title: 'Time range', body: 'Narrow to the window around an incident instead of scrolling through a week.' },
      ],
      tip: 'When something broke, start here and work outward. The event before the failure is usually the interesting one.',
    },
    ro: {
      title: 'Cronologie evenimente', icon: 'fa-stream',
      intro: 'Ce s-a intamplat in parc, in ordine, cu categoriile separate.',
      sections: [
        { icon: 'fa-filter', title: 'Categorii', body: 'Deploy-uri, ciclu de viata, actiuni, alerte, autentificare si securitate pot fi citite impreuna sau pe rand.' },
        { icon: 'fa-clock', title: 'Interval de timp', body: 'Restrange la fereastra din jurul incidentului in loc sa derulezi o saptamana intreaga.' },
      ],
      tip: 'Cand s-a stricat ceva, incepe de aici si mergi spre exterior. Evenimentul dinaintea esecului e de obicei cel interesant.',
    },
  },

  'howto': {
    en: {
      title: 'How-To Guides', icon: 'fa-book',
      intro: 'Task-oriented guides for the things operators actually have to do, shipped with the application.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Finding a guide', body: 'Guides are grouped by topic and searchable. They are written for the task, not for the feature.' },
        { icon: 'fa-wifi', title: 'Available offline', body: 'The content ships inside the application, so it works on an air-gapped install with no internet access.' },
      ],
      tip: 'Guides describe the general case. Where your estate differs, the guide is a starting point, not a script.',
    },
    ro: {
      title: 'Ghiduri practice', icon: 'fa-book',
      intro: 'Ghiduri orientate pe sarcini, pentru lucrurile pe care operatorii chiar trebuie sa le faca, livrate cu aplicatia.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Cum gasesti un ghid', body: 'Ghidurile sunt grupate pe teme si se pot cauta. Sunt scrise pentru sarcina, nu pentru functionalitate.' },
        { icon: 'fa-wifi', title: 'Disponibile offline', body: 'Continutul e livrat in aplicatie, deci functioneaza si pe o instalare izolata, fara internet.' },
      ],
      tip: 'Ghidurile descriu cazul general. Acolo unde parcul tau difera, ghidul e un punct de plecare, nu un script.',
    },
  },

  'observability': {
    en: {
      title: 'Observability', icon: 'fa-chart-line',
      intro: 'A wizard that detects what monitoring you already run and shows the right next step for it.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Detection', body: 'Scans running containers for Prometheus and Grafana. It reads only; it never modifies Docker state.' },
        { icon: 'fa-file-code', title: 'Scrape config', body: 'Produces the exact scrape snippet for the metrics endpoint, so you do not have to guess the target or port.' },
        { icon: 'fa-upload', title: 'Dashboard import', body: 'Pushes the bundled dashboard to your Grafana. The token you supply is forwarded and discarded, never stored.' },
      ],
      tip: 'Detection only sees the local daemon. Prometheus on another host needs the manual form, not a rescan.',
    },
    ro: {
      title: 'Observabilitate', icon: 'fa-chart-line',
      intro: 'Un wizard care detecteaza ce monitorizare ai deja si iti arata pasul potrivit pentru ea.',
      sections: [
        { icon: 'fa-magnifying-glass', title: 'Detectie', body: 'Scaneaza containerele active dupa Prometheus si Grafana. Doar citeste; nu modifica niciodata starea Docker.' },
        { icon: 'fa-file-code', title: 'Configuratie de scrape', body: 'Produce fragmentul exact pentru endpoint-ul de metrici, ca sa nu ghicesti tinta sau portul.' },
        { icon: 'fa-upload', title: 'Import de dashboard', body: 'Trimite dashboard-ul inclus catre Grafana ta. Token-ul furnizat e transmis si aruncat, niciodata stocat.' },
      ],
      tip: 'Detectia vede doar daemonul local. Un Prometheus de pe alt host cere formularul manual, nu o rescanare.',
    },
  },

  'sample-feature': {
    en: {
      title: 'Sample Plugin', icon: 'fa-puzzle-piece',
      intro: 'A reference page showing the conventions a new Docker Dash page is expected to follow.',
      sections: [
        { icon: 'fa-code', title: 'What it demonstrates', body: 'Page structure, API access, loading and error states, and the audit and permission patterns a real page needs.' },
        { icon: 'fa-flask', title: 'Not a product feature', body: 'It exists for developers extending the application. Nothing here manages your estate.' },
      ],
      tip: 'Copy this page as the starting point for a new one — it already satisfies the conventions a review will check.',
    },
    ro: {
      title: 'Plugin exemplu', icon: 'fa-puzzle-piece',
      intro: 'O pagina de referinta care arata conventiile pe care trebuie sa le respecte o pagina noua din Docker Dash.',
      sections: [
        { icon: 'fa-code', title: 'Ce demonstreaza', body: 'Structura paginii, accesul la API, starile de incarcare si eroare, si tiparele de audit si permisiuni de care are nevoie o pagina reala.' },
        { icon: 'fa-flask', title: 'Nu e o functionalitate de produs', body: 'Exista pentru dezvoltatorii care extind aplicatia. Nimic de aici nu gestioneaza infrastructura ta.' },
      ],
      tip: 'Copiaza aceasta pagina ca punct de plecare pentru una noua — respecta deja conventiile pe care le verifica un review.',
    },
  },

  'registry-browse': {
    en: {
      title: 'Registry Browser', icon: 'fa-boxes-stacked',
      intro: 'Browse the image registries you have configured: repositories, tags and digests.',
      sections: [
        { icon: 'fa-folder-open', title: 'Repositories and tags', body: 'What each registry holds, with the digest behind every tag so you can tell two identical tags apart.' },
        { icon: 'fa-key', title: 'Credentials', body: 'Registry credentials are encrypted at rest and are configured under Settings, not here.' },
      ],
      tip: 'Tags move, digests do not. Pin to a digest when you need to be sure you are running the same image tomorrow.',
    },
    ro: {
      title: 'Explorator de registre', icon: 'fa-boxes-stacked',
      intro: 'Rasfoieste registrele de imagini configurate: repository-uri, tag-uri si digest-uri.',
      sections: [
        { icon: 'fa-folder-open', title: 'Repository-uri si tag-uri', body: 'Ce contine fiecare registru, cu digest-ul din spatele fiecarui tag, ca sa deosebesti doua tag-uri identice.' },
        { icon: 'fa-key', title: 'Credentiale', body: 'Credentialele de registru sunt criptate la repaus si se configureaza in Setari, nu aici.' },
      ],
      tip: 'Tag-urile se muta, digest-urile nu. Fixeaza pe digest cand vrei sa fii sigur ca maine rulezi aceeasi imagine.',
    },
  },

  'onboarding': {
    en: {
      title: 'Environment Setup', icon: 'fa-wand-magic-sparkles',
      intro: 'Guided provisioning of a new environment: hosts, access and the starting configuration.',
      sections: [
        { icon: 'fa-list-ol', title: 'Guided steps', body: 'The wizard walks the setup in order and validates each step before moving on.' },
        { icon: 'fa-rotate-left', title: 'Failure handling', body: 'A step that fails is reported with what it attempted, and completed work is compensated rather than left half-applied.' },
        { icon: 'fa-shield', title: 'Secrets', body: 'Templates must reference secrets rather than embed them; inline secret material is rejected before anything is persisted.' },
      ],
      tip: 'Run it against a test environment first. The wizard creates real resources, not a preview.',
    },
    ro: {
      title: 'Configurare mediu', icon: 'fa-wand-magic-sparkles',
      intro: 'Provisionare ghidata a unui mediu nou: hosturi, acces si configuratia de start.',
      sections: [
        { icon: 'fa-list-ol', title: 'Pasi ghidati', body: 'Wizard-ul parcurge configurarea in ordine si valideaza fiecare pas inainte sa continue.' },
        { icon: 'fa-rotate-left', title: 'Tratarea esecurilor', body: 'Un pas esuat e raportat cu ce a incercat, iar munca deja facuta e compensata, nu lasata pe jumatate.' },
        { icon: 'fa-shield', title: 'Secrete', body: 'Template-urile trebuie sa refere secretele, nu sa le contina; materialul secret inline e respins inainte de persistare.' },
      ],
      tip: 'Ruleaza-l intai pe un mediu de test. Wizard-ul creeaza resurse reale, nu o previzualizare.',
    },
  },

  'governance': {
    en: {
      title: 'Governance', icon: 'fa-building-shield',
      intro: 'The controls that decide who may do what, and the evidence that it was followed.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'Policy', body: 'Rules applied to actions across the estate, evaluated the same way regardless of which page triggered the action.' },
        { icon: 'fa-clipboard-check', title: 'Evidence', body: 'Decisions are recorded with what was checked, so a control can be demonstrated rather than asserted.' },
      ],
      tip: 'A control nobody can produce evidence for is a policy, not a control. This page is about the difference.',
    },
    ro: {
      title: 'Guvernanta', icon: 'fa-building-shield',
      intro: 'Controalele care decid cine ce poate face, si dovada ca au fost respectate.',
      sections: [
        { icon: 'fa-scale-balanced', title: 'Politica', body: 'Reguli aplicate actiunilor din parc, evaluate la fel indiferent de pagina care a declansat actiunea.' },
        { icon: 'fa-clipboard-check', title: 'Dovezi', body: 'Deciziile sunt inregistrate cu ce s-a verificat, deci un control poate fi demonstrat, nu doar afirmat.' },
      ],
      tip: 'Un control pentru care nimeni nu poate produce dovezi e o politica, nu un control. Pagina asta e despre diferenta.',
    },
  },

  'governance-controls': {
    en: {
      title: 'Identity & Policy', icon: 'fa-user-shield',
      intro: 'Capacity limits, federated identities, short-lived credentials, approvals and change freezes.',
      sections: [
        { icon: 'fa-gauge-high', title: 'Capacity limits', body: 'Ceilings that stop a single team or project consuming the whole estate.' },
        { icon: 'fa-id-badge', title: 'Federated identity', body: 'Where users come from and how they are mapped to roles here.' },
        { icon: 'fa-hourglass-half', title: 'Short-lived credentials', body: 'Elevated access is granted with a scope and an expiry rather than held permanently.' },
        { icon: 'fa-snowflake', title: 'Approvals and freezes', body: 'Changes can require approval, and a freeze window blocks them outright until it lifts.' },
      ],
      tip: 'Short-lived grants are scoped to a user, an endpoint and a permission. A grant is not a general elevation.',
    },
    ro: {
      title: 'Identitate si politica', icon: 'fa-user-shield',
      intro: 'Limite de capacitate, identitati federate, credentiale de scurta durata, aprobari si perioade de inghet.',
      sections: [
        { icon: 'fa-gauge-high', title: 'Limite de capacitate', body: 'Plafoane care impiedica o singura echipa sau un proiect sa consume tot parcul.' },
        { icon: 'fa-id-badge', title: 'Identitate federata', body: 'De unde vin utilizatorii si cum sunt mapati la roluri aici.' },
        { icon: 'fa-hourglass-half', title: 'Credentiale de scurta durata', body: 'Accesul elevat se acorda cu un scop si o expirare, nu se detine permanent.' },
        { icon: 'fa-snowflake', title: 'Aprobari si inghet', body: 'Schimbarile pot cere aprobare, iar o fereastra de inghet le blocheaza pana la ridicarea ei.' },
      ],
      tip: 'Drepturile de scurta durata sunt legate de un utilizator, un endpoint si o permisiune. Un drept acordat nu e o elevare generala.',
    },
  },

  'self-service': {
    en: {
      title: 'Self-Service', icon: 'fa-hand-holding-heart',
      intro: 'Curated offerings that let teams provision for themselves inside limits you set.',
      sections: [
        { icon: 'fa-box-open', title: 'Offerings', body: 'What a team may request, described in their terms rather than as raw infrastructure.' },
        { icon: 'fa-lock', title: 'Policy-scoped', body: 'Every action stays inside the policy attached to the project. Self-service is not unsupervised access.' },
        { icon: 'fa-receipt', title: 'Auditable fulfillment', body: 'Who requested what, what was created, and when — recorded for every fulfilled request.' },
      ],
      tip: 'A good offering hides the infrastructure and exposes the decision. If users must understand your storage layout, the offering is too raw.',
    },
    ro: {
      title: 'Autoservire', icon: 'fa-hand-holding-heart',
      intro: 'Oferte curatate care permit echipelor sa isi provisioneze singure resurse, in limitele stabilite de tine.',
      sections: [
        { icon: 'fa-box-open', title: 'Oferte', body: 'Ce poate cere o echipa, descris in termenii lor, nu ca infrastructura bruta.' },
        { icon: 'fa-lock', title: 'Limitat de politica', body: 'Fiecare actiune ramane in politica atasata proiectului. Autoservirea nu inseamna acces nesupravegheat.' },
        { icon: 'fa-receipt', title: 'Livrare auditabila', body: 'Cine a cerut ce, ce s-a creat si cand — inregistrat pentru fiecare cerere onorata.' },
      ],
      tip: 'O oferta buna ascunde infrastructura si expune decizia. Daca utilizatorii trebuie sa inteleaga structura ta de stocare, oferta e prea bruta.',
    },
  },

  'edge-platform': {
    en: {
      title: 'Edge & Disconnected', icon: 'fa-tower-cell',
      intro: 'Operations for remote, low-bandwidth and air-gapped sites that cannot assume a live connection.',
      sections: [
        { icon: 'fa-map-pin', title: 'Sites and connectivity', body: 'Each edge site and how reachable it currently is, so an offline site is a known state rather than a failure.' },
        { icon: 'fa-inbox', title: 'Offline intents', body: 'Work queued for a site that is not reachable yet, held until it is rather than failing outright.' },
        { icon: 'fa-truck-fast', title: 'Store-and-forward', body: 'Results and evidence are collected locally and forwarded when a link returns.' },
        { icon: 'fa-robot', title: 'Local agents', body: 'Agents at the site and the state of their updates.' },
      ],
      tip: 'Design for the link being down as the normal case. An edge site that only works while connected is not an edge site.',
    },
    ro: {
      title: 'Edge si deconectat', icon: 'fa-tower-cell',
      intro: 'Operatiuni pentru site-uri la distanta, cu banda mica sau izolate, care nu pot presupune o conexiune vie.',
      sections: [
        { icon: 'fa-map-pin', title: 'Site-uri si conectivitate', body: 'Fiecare site edge si cat de accesibil e in acest moment, ca un site offline sa fie o stare cunoscuta, nu un esec.' },
        { icon: 'fa-inbox', title: 'Intentii offline', body: 'Munca pusa la coada pentru un site inca inaccesibil, retinuta pana devine accesibil, nu esuata direct.' },
        { icon: 'fa-truck-fast', title: 'Store-and-forward', body: 'Rezultatele si dovezile se aduna local si se trimit cand revine legatura.' },
        { icon: 'fa-robot', title: 'Agenti locali', body: 'Agentii de la fata locului si starea actualizarilor lor.' },
      ],
      tip: 'Proiecteaza pornind de la ideea ca legatura e cazuta, ca situatie normala. Un site edge care merge doar cand e conectat nu e un site edge.',
    },
  },

  'workstation-fleet': {
    en: {
      title: 'Workstation Fleet', icon: 'fa-laptop',
      intro: 'Image-based workstations inventoried from Foreman or Katello, with a guarded update path.',
      sections: [
        { icon: 'fa-fingerprint', title: 'Digest-pinned images', body: 'Every bootc image is identified by digest, with provenance and SBOM evidence and an explicit signer policy.' },
        { icon: 'fa-list-check', title: 'Inventory and drift', body: 'Read-only inventory from Foreman, with posture and drift per workstation.' },
        { icon: 'fa-code-branch', title: 'Release channels', body: 'Held, canary and stable channels decide which machines take an update and when.' },
        { icon: 'fa-shield', title: 'Guarded execution', body: 'Update and rollback are default-off, bound to fresh evidence, and require typed confirmation. Nothing runs on a stale plan.' },
      ],
      tip: 'Canary a channel before promoting to stable. A digest-pinned rollout is still a rollout.',
    },
    ro: {
      title: 'Parc de statii de lucru', icon: 'fa-laptop',
      intro: 'Statii de lucru bazate pe imagini, inventariate din Foreman sau Katello, cu o cale de update protejata.',
      sections: [
        { icon: 'fa-fingerprint', title: 'Imagini fixate pe digest', body: 'Fiecare imagine bootc e identificata prin digest, cu dovezi de provenienta si SBOM si o politica explicita de semnatar.' },
        { icon: 'fa-list-check', title: 'Inventar si derapaj', body: 'Inventar read-only din Foreman, cu postura si derapaj per statie.' },
        { icon: 'fa-code-branch', title: 'Canale de release', body: 'Canalele held, canary si stable decid ce masini iau un update si cand.' },
        { icon: 'fa-shield', title: 'Executie protejata', body: 'Update-ul si rollback-ul sunt implicit dezactivate, legate de dovezi proaspete si cer confirmare scrisa. Nimic nu ruleaza pe un plan invechit.' },
      ],
      tip: 'Treci intai printr-un canal canary inainte de promovarea la stable. Un rollout fixat pe digest e tot un rollout.',
    },
  },
};
