# browser-chaperone

## Prerequisite on the NAS

**The db data directory must exist and be owned by 999:999 before the PV is applied.**
hostPath volumes are not chowned by the kubelet, and the postgres image runs as uid/gid 999.

```bash
ssh nas 'sudo mkdir -p /mnt/thedatapool/app-data/browser-chaperone/prod/db-data \
  && sudo chown -R 999:999 /mnt/thedatapool/app-data/browser-chaperone/prod/db-data'
```
