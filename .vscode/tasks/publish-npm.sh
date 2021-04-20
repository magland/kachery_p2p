#!/bin/bash
# This file was automatically generated by jinjaroot. Do not edit directly.


set -e

# check that we have a clean working directory
if [ -z "$(git status --porcelain)" ]; then 
  echo "Working directory is clean"
else
  echo "Working directory is not clean (use git status)"
  exit 1
fi

# verify that code generation is up-to-date (if not throws an error)
jinjaroot verify

# run pre-publish-tasks.sh
.vscode/tasks/pre-publish-tasks.sh

cd ./daemon

# install and build
yarn install
yarn build

# dry run
npm run publish-dry

# Confirm publish
while true; do
    read -p "Publish version 0.8.25 (y/n)?" yn
    case $yn in
        [Yy]* ) break;;
        [Nn]* ) echo "aborting"; exit;;
        * ) echo "Please answer yes or no.";;
    esac
done

# publish
npm run publish-go