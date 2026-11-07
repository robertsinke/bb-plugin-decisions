# Decisions

A BB plugin. It stores a TypeSafe API key and a decision-model id (default `jev-latest`, the current Jev alias). The Decisions icon on the rail opens usage charts: how many asks, who sent them, and how sure the yes/no answers were. Named asks are stored in this plugin's database. Threads add one with the `decisions_add_question` tool. The page edits the name and the sentences. The inbox sends the one marked in use. Renaming does not re-score a chat. Changing the sentences does: lines already scored in the current span are asked again, and older lines stay out. The first open also reads this plugin's own log and the scores unified-inbox still has, so earlier inbox asks show up. The charts count calls. They do not show the question text or the API key. Waits and token totals start with the asks recorded after the page existed. Cost is those input tokens at Jev's list price, $0.042 per million. Output tokens are free. Asks from before token counts were kept are left out of the cost.

Other plugins call RPC method `ask` on plugin id `decisions`. Threads use the `decisions_ask` tool. The key stays in this plugin's secret settings. It is not copied into an agent environment, because BB records those values in the timeline.

```sh
bb plugin install .
bb plugin config decisions set apiKey <key>
bb decisions status
```

See `skills/decisions/SKILL.md` for the request shape. unified-inbox can classify a message by calling `ask` and applying its own rules to the probabilities.
