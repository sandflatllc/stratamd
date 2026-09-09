# T3 additions design review

The current mockups are **revision 2**, rebuilt from the running Strata renderer with the default **Strata** theme. Revision 1 is superseded and must not be used as an implementation benchmark.

Open [the interactive gallery](http://127.0.0.1:43871/v2/) or read [the benchmark guide](v2/benchmark-guide.md). The root gallery URL redirects to revision 2 and preserves flow/state links.

All 15 accepted additions are covered by 12 flows and 58 visual states. Each state has a current Strata baseline, a clean proposal, a numbered highlight image, and a JSON specification identifying source components, changed elements, layout effects, and behavior checks. Feature 4 also has an explicit unchanged-UI specification.

The [saved review](v2/owner-review.md) records nine approved flows, one needing changes, and two without a saved decision. Approved flows with comments keep their approval while the named corrections are made. Product implementation has not started. Review notes and local approval markers are stored only in the review browser and must be shared in chat.

The [UI inventory](ui-inventory.md) and [original research](../../reviews/t3-recent-additions-ranked-2026-09-08.md) remain the scope basis. The active files are in `v2/`. Earlier captures and the `*-v1` guides are retained as superseded history.

The preview runs on port 43871 as the user service `strata-t3-design-gallery.service`, independent of the chat process. It restarts after a server crash. It is temporary for this login session and is not enabled at boot.

If the service stops, restart it with this command.

```bash
systemctl --user restart strata-t3-design-gallery.service
```

If the temporary service no longer exists after a reboot, run this from this design folder.

```bash
systemd-run --user --unit=strata-t3-design-gallery --description='Strata T3 additions design gallery' --property=Restart=on-failure --property=RestartSec=2 /usr/bin/python3 -m http.server 43871 --bind 127.0.0.1 --directory "$PWD"
```

The gallery needs no package installation and makes no engine or provider calls. `v2/verification.json` records the capture evidence. No product source, owner profile, installed app, or active skill was changed.
