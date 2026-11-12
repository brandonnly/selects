# Glossary

| Term | Meaning |
| --- | --- |
| **Select** | One finished photo in the library. The original file is kept untouched. |
| **Library** | Every select the install knows about, posted or not. |
| **Pool** | The selects that have not been posted and are eligible to be picked. |
| **Queue** | An ordered list of selects chosen by hand. It is drained before the pool. |
| **Inbox** | The watched folder. A file dropped there is ingested and moved out. |
| **Slot** | One entry in the schedule: days of the week, a time, and an optional random spread. |
| **Pick** | Choosing the select for a slot: the head of the queue, or one from the pool under the pick rules. |
| **Pick rule** | A switchable constraint on picks from the pool, such as spacing by capture day. |
| **Next up** | The pick for the coming slot, made a day ahead so it can be swapped or skipped. |
| **Frame** | The rendered 4:5 image: the photo, a border, and a line of metadata. |
| **Post** | One publication to Instagram. A post holds one select today and may hold several later. |
| **Privacy zone** | A point and a radius. A select taken inside one never has its location published. |
| **Gallery output** | The clean image and manifest entry written to the bucket for a public gallery. |
| **Manifest** | `posts.json` in the bucket: one entry per post, read by the gallery and other sites. |
| **Dry run** | A mode that renders and logs everything a post would do without publishing. |
