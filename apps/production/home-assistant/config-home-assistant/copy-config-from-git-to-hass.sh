#!/usr/bin/env bash
# Syncs only the config files Home Assistant itself writes (automations.yaml,
# scenes.yaml, scripts.yaml, secrets.yaml). Static config is delivered by Flux
# as ConfigMaps -- see ../kustomization.yaml -- and is listed in
# rsync-excluded-files so this script cannot overwrite it.
THISDIR=$(cd $(dirname "$0"); pwd) #this script's directory

GIT_DIR=$THISDIR
HASS_DIR=scott@nas.activescott.com:/mnt/thedatapool/app-data/home-assistant

RSYNC_OPTIONS='-v --recursive --delete --times --exclude-from=rsync-excluded-files'
rsync --dry-run $RSYNC_OPTIONS "$GIT_DIR/" "$HASS_DIR/"

while true; do
    printf "\n"
    read -p "Above is a list of changes do you want to continue? (yes or no)" yn
    case $yn in
        [Yy]* ) rsync $RSYNC_OPTIONS "$GIT_DIR/" "$HASS_DIR/"; break;;
        [Nn]* ) exit;;
        * ) echo "Please answer yes or no.";;
    esac
done
