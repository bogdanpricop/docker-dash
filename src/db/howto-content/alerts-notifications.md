---
title: Setting Up Alerts
summary: Configure CPU/memory alerts with Discord, Slack, Telegram, or email notifications.
category: docker-dash
difficulty: beginner
icon: fas fa-bell
---

<h2>Setting Up Alerts &amp; Notifications</h2>
<p>Docker Dash can notify you when containers misbehave — before your users notice. Set up alert rules and notification channels in minutes.</p>

<h3>Create an Alert Rule</h3>
<ol>
  <li>Go to <strong>Alerts → Rules → New Rule</strong></li>
  <li>Choose a metric: <strong>CPU</strong>, <strong>Memory</strong>, <strong>Container Down</strong>, or <strong>Restart Count</strong></li>
  <li>Set the threshold — e.g. CPU &gt; 80%</li>
  <li>Set the duration — e.g. for 5 minutes (avoids false positives from spikes)</li>
  <li>Assign a notification channel</li>
  <li>Save and enable the rule</li>
</ol>

<h3>Add a Notification Channel</h3>
<p>Go to <strong>Settings → Notifications → Add Channel</strong> and choose your platform. Set <strong>Use channel for</strong> to <strong>Scheduled scans only</strong> to reserve the channel for scan reports. Choose <strong>General notifications only</strong> for operational messages or the combined option to receive both.</p>

<h4>Discord</h4>
<p>Create a webhook in your Discord server (Server Settings → Integrations → Webhooks) and paste the URL.</p>

<h4>Slack</h4>
<p>Create an Incoming Webhook app in Slack and paste the webhook URL.</p>

<h4>Telegram</h4>
<p>Create a bot via <code>@BotFather</code>, get the bot token, and find your chat ID with <code>@userinfobot</code>.</p>

<h4>Email</h4>
<p>Enter your SMTP server details (host, port, username, password, TLS) and a recipient address.</p>

<h3>Test the Channel</h3>
<p>After saving, click <strong>Send Test</strong>. You should receive a test message within seconds. If not, check the channel configuration and Docker Dash logs.</p>

<h3>Common Alert Rules to Start With</h3>
<ul>
  <li>CPU &gt; 85% for 5 minutes</li>
  <li>Memory &gt; 90% for 2 minutes</li>
  <li>Container status = stopped (immediate)</li>
  <li>Container restart count &gt; 3 in 10 minutes</li>
</ul>
