{
  "targets": [
    {
      "target_name": "peercred",
      "sources": ["peercred.c"],
      "conditions": [
        ["OS!='linux'", { "type": "none" }]
      ]
    }
  ]
}
