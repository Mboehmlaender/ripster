#!/bin/bash

REPO="mboehmlaender/ripster"

echo "Fetching deployments..."

DEPLOYMENTS=$(gh api repos/$REPO/deployments --paginate \
  --jq 'sort_by(.created_at) | reverse | .[1:] | .[].id')

if [ -z "$DEPLOYMENTS" ]; then
  echo "Nothing to delete. Only one or zero deployments exist."
  exit 0
fi

echo
echo "The following deployments will be deleted:"
echo "$DEPLOYMENTS"
echo

read -p "Proceed with deletion? (y/N): " confirm

if [[ "$confirm" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

for id in $DEPLOYMENTS; do
  echo "Deleting deployment $id"
  gh api --method DELETE repos/$REPO/deployments/$id
done

echo "Done."
