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
| **Grace period** | How late a slot missed while Selects was down may still post. Past it the slot is skipped; missed slots never stack. |
| **Frame** | The rendered 4:5 image: the photo, a border, and a line of metadata. |
| **Post** | One publication to Instagram. A post holds one select today and may hold several later. |
| **Template** | The text a caption or alt text is built from, with tokens where a select's data goes. |
| **Token** | A field name in braces in a template, such as `{camera}`, replaced by the select's value. |
| **Hashtag set** | A named list of hashtags. One set is chosen at random for each post. |
| **Privacy zone** | A point and a radius. A select taken inside one never has its location published. |
| **Gallery output** | The clean image and manifest entry written to the bucket for a public gallery. |
| **Manifest** | `posts.json` in the bucket: one entry per post, read by the gallery and other sites. |
| **Dry run** | A mode that renders and logs everything a post would do without publishing. |
| **Fake mode** | The default: Instagram and the bucket are fakes inside Selects, and nothing leaves the install. `INSTAGRAM_API=live` turns it off. |
| **Unconfirmed post** | A post Instagram was asked to publish without confirming whether it did. Its select stays out of the pool until Instagram or the owner says. |
