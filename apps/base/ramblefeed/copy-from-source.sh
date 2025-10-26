#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
this_script=$(basename $0)
this_script_base=$(basename "$0" .sh)

cp ~/src/activescott/ramblefeed/k8s/base/*.yaml "$this_dir/"
