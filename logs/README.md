# NanoClaw logs

This deployment sends NanoClaw service output to the systemd user journal.
The files previously stored in this directory were legacy logs and have been
removed.

```bash
# Follow live service output
journalctl --user -u nanoclaw.service -f

# Show output from the current boot
journalctl --user -u nanoclaw.service -b

# Show recent output
journalctl --user -u nanoclaw.service --since "1 hour ago"

# Show warnings and errors from the current boot
journalctl --user -u nanoclaw.service -b -p warning
```

Setup and migration commands may still create temporary diagnostic files under
this directory. Those files are ignored by Git and can be removed after the
operation is complete.