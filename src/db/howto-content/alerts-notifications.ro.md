---
title: Configurare alerte
summary: Configurează alerte CPU/memorie cu notificări Discord, Slack, Telegram sau email.
---

<h2>Configurare alerte și notificări</h2>
<p>Docker Dash te poate notifica când containerele se comportă anormal — înainte ca utilizatorii să observe. Configurează reguli de alertă și canale de notificare în câteva minute.</p>

<h3>Creează o regulă de alertă</h3>
<ol>
  <li>Mergi la <strong>Alerts → Rules → New Rule</strong></li>
  <li>Alege o metrică: <strong>CPU</strong>, <strong>Memory</strong>, <strong>Container Down</strong> sau <strong>Restart Count</strong></li>
  <li>Setează pragul — ex. CPU &gt; 80%</li>
  <li>Setează durata — ex. timp de 5 minute (evită false pozitive din spike-uri)</li>
  <li>Asignează un canal de notificare</li>
  <li>Salvează și activează regula</li>
</ol>

<h3>Adaugă un canal de notificare</h3>
<p>Mergi la <strong>Setări → Notificări → Adaugă canal</strong> și alege platforma. La <strong>Folosește canalul pentru</strong>, selectează <strong>Doar scanări programate</strong> pentru a primi rapoartele de scanare. Alege <strong>Doar notificări generale</strong> pentru mesajele operaționale sau opțiunea combinată pentru ambele tipuri de mesaje.</p>

<h4>Discord</h4>
<p>Creează un webhook în serverul tău Discord (Server Settings → Integrations → Webhooks) și lipește URL-ul.</p>

<h4>Slack</h4>
<p>Creează o aplicație Incoming Webhook în Slack și lipește URL-ul webhook-ului.</p>

<h4>Telegram</h4>
<p>Creează un bot via <code>@BotFather</code>, obține token-ul botului și găsește ID-ul chat-ului cu <code>@userinfobot</code>.</p>

<h4>Email</h4>
<p>Introdu detaliile serverului SMTP (host, port, utilizator, parolă, TLS) și adresa destinatarului.</p>

<h3>Testează canalul</h3>
<p>După salvare, apasă <strong>Send Test</strong>. Ar trebui să primești un mesaj de test în câteva secunde.</p>

<h3>Reguli de alertă recomandate pentru început</h3>
<ul>
  <li>CPU &gt; 85% timp de 5 minute</li>
  <li>Memory &gt; 90% timp de 2 minute</li>
  <li>Stare container = oprit (imediat)</li>
  <li>Număr de restart-uri &gt; 3 în 10 minute</li>
</ul>
