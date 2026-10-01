# wordpress-micah-mmm-v2

mmm.willeke.com, on the `wordpress-upstream` base. See
`apps/base/wordpress-upstream/README.md` for how the base works and the
checks for going live.

## Removing inactive themes and plugins

WordPress cannot delete themes or plugins here (`DISALLOW_FILE_MODS`, and
wp-content is read-only to it), so Site Health's "Remove inactive plugins"
and "Remove inactive themes" are done on nas.

The ones that ship with WordPress are removed by `patch-bundled-content.yaml`
on every start, because install-core would copy them back. Anything else is
deleted from the host volume.

See what is active:

```sh
kubectl --context nas -n wordpress-micah-mmm-v2 exec mariadb-0 -- sh -c \
  'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" -e \
  "SELECT option_name, option_value FROM wp_options WHERE option_name IN (\"template\", \"stylesheet\", \"active_plugins\")"'
```

`template` and `stylesheet` should both be `garden-lawn-care`. If they
differ, `stylesheet` is a child theme and `template` is its parent, and both
stay. `active_plugins` is a serialized PHP array of paths such as
`contact-form-7/wp-contact-form-7.php`; the part before the slash is the
directory.

See what is installed, on nas:

```sh
ls /mnt/thedatapool/app-data/wordpress-micah-mmm/wp-content/themes \
   /mnt/thedatapool/app-data/wordpress-micah-mmm/wp-content/plugins
```

Keep in `themes/` the active theme, `twentytwentyfive` (the fallback that
Site Health does not count) and `index.php`. Keep in `plugins/` each active
plugin's directory and `index.php`. Delete the rest, one entry at a time,
taking a copy first:

```sh
cd /mnt/thedatapool/app-data/wordpress-micah-mmm/wp-content
sudo tar czf ~/mmm-removed-$(date +%Y%m%d).tar.gz themes/<name> plugins/<name>
sudo rm -rf themes/<name>
sudo rm -rf plugins/<name>
```

WordPress reads these directories on each request, so no restart is needed.
If a plugin you deleted was active after all, WordPress stops loading it at
once and drops it from the active list when someone opens the Plugins
screen; restore it from the tarball, owned by 33:33.
