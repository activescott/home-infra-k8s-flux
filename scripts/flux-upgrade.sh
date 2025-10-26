#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
this_script=$(basename $0)

# https://fluxcd.io/flux/installation/upgrade/

cluster_name="nas1"

echo "**** Starting Flux Upgrade ****"
echo "The current version of flux is $(flux --version)"
flux install --export > "./clusters/$cluster_name/flux-system/gotk-components.yaml"

git add "./clusters/$cluster_name/flux-system"
git commit -m "Update $(flux -v) on $cluster_name cluster"

echo "**** Flux Upgrade Completed ****"
