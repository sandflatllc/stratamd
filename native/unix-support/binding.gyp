{
  "targets": [
    {
      "target_name": "unix_support",
      "sources": ["unix-support.c"],
      "conditions": [
        ["OS=='win'", { "sources": ["windows-files.c"] }],
        ["OS!='linux' and OS!='mac' and OS!='win'", { "type": "none" }]
      ]
    }
  ]
}
