# List-item inline markup

A paragraph is the control: **bold**, _em_, `code`, [label](https://example.com/p) and
~~struck~~ have always been parsed here.

- tight: **bold**, _em_, `code`, [label](https://example.com/p) and ~~struck~~
- tight, authored soft break: this line was wrapped by its author
  and continues here, so the two must coalesce into one logical line
- tight, authored hard break: this line ends in two spaces  
  so this one must stay on a line of its own

* loose: **bold**, _em_, `code`, [label](https://example.com/p) and ~~struck~~

* loose, second item so the list stays loose

1. ordered: **bold**, _em_, `code`, [label](https://example.com/p) and ~~struck~~

- outer item
  - nested: **bold**, _em_, `code`, [label](https://example.com/p) and ~~struck~~

- [ ] task open: **bold** and [label](https://example.com/p)
- [x] task done: **bold** and [label](https://example.com/p)

- reference link: [ref label][example-ref] resolves to its definition
- self link: [https://example.com/p](https://example.com/p) renders its href once
- escaped: \*not emphasis\* stays literal text
- fence inside an item, verbatim:

  ```bash
  echo "**not bold**" > /home/example/out.md
  ```

[example-ref]: https://example.com/reference
