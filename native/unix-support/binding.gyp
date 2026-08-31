{
  "targets": [
    {
      "target_name": "unix_support",
      "sources": ["unix-support.c"],
      "conditions": [
        ["OS!='linux' and OS!='mac'", { "type": "none" }]
      ]
    }
  ]
}
