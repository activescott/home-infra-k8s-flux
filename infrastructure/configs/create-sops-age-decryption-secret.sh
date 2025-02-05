#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory

# NOTE: Create a secret with the age private key, the key name must end with .agekey to be detected as an age key:
cat "$this_dir/home-infra-private.agekey" |
kubectl create secret generic sops-age \
--namespace=flux-system \
--from-file="home-infra-private.agekey=/dev/stdin"
