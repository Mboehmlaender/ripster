#!/bin/bash
set -e

# =====================================
# StackPulse Dev-Skript – Hauptmenü & Aktionen
# =====================================

show_menu() {
  cat <<'MENU'
Bitte wähle eine Aktion:

  1) Neues Feature anlegen
  2) Merge & Commit
  3) Dev-Umgebungen
  4) Hotfix
  5) Branch-Verwaltung
  6) Branch wechseln
  0) Beenden
MENU
}

pause_for_menu() {
  echo ""
  read -rp "Zurück zum Hauptmenü mit Enter... " _
}

merge_commit_menu() {
  local selection
  while true; do
    echo ""
    cat <<'MENU'
Merge & Commit – Aktionen:

  1) Feature-Branch in dev mergen
  2) dev in master mergen
  3) Änderungen committen & pushen
  4) Docker-Release bauen & pushen
  5) Git-Stashes verwalten
  6) README in Feature-Branches aktualisieren
  0) Zurück
MENU
    read -rp "Auswahl: " selection
    echo ""
    case $selection in
      1)
        merge_feature_into_dev
        pause_for_menu
        ;;
      2)
        merge_dev_into_master
        pause_for_menu
        ;;
      3)
        push_changes
        pause_for_menu
        ;;
      4)
        docker_release
        pause_for_menu
        ;;
      5)
        manage_stash
        pause_for_menu
        ;;
      6)
        sync_readme_to_features
        pause_for_menu
        ;;
      0)
        break
        ;;
      *)
        echo "❌ Ungültige Auswahl."
        ;;
    esac
  done
}

dev_environments_menu() {
  local selection
  while true; do
    echo ""
    cat <<'MENU'
Dev-Umgebungen:

  1) Dev-Umgebung starten
  2) Docker Compose (lokal) starten
  0) Zurück
MENU
    read -rp "Auswahl: " selection
    echo ""
    case $selection in
      1)
        start_dev_environment
        pause_for_menu
        ;;
      2)
        start_docker_compose
        pause_for_menu
        ;;
      0)
        break
        ;;
      *)
        echo "❌ Ungültige Auswahl."
        ;;
    esac
  done
}

hotfix_menu() {
  local selection
  while true; do
    echo ""
    cat <<'MENU'
Hotfix:

  1) Neuen Hotfix erstellen
  2) Hotfix auf master anwenden (Cherry-Pick)
  3) Hotfix auf dev anwenden (Cherry-Pick)
  4) Hotfix auf Feature-Branches anwenden (Cherry-Pick)
  0) Zurück
MENU
    read -rp "Auswahl: " selection
    echo ""
    case $selection in
      1)
        create_hotfix_branch
        pause_for_menu
        ;;
      2)
        apply_hotfix_to_master
        pause_for_menu
        ;;
      3)
        apply_hotfix_to_dev
        pause_for_menu
        ;;
      4)
        apply_hotfix_to_features
        pause_for_menu
        ;;
      0)
        break
        ;;
      *)
        echo "❌ Ungültige Auswahl."
        ;;
    esac
  done
}

create_hotfix_branch() {
  local -a TAGS
  local selection selected_tag hotfix_name
  local version_without_prefix patch_part branch_version branch_name
  local -a ver_parts

  if ! git diff-index --quiet HEAD --; then
    echo "⚠️ Es gibt noch uncommittete Änderungen. Bitte committen oder stashen, bevor ein Hotfix-Branch erstellt wird."
    return 1
  fi

  git fetch --tags >/dev/null 2>&1 || true
  mapfile -t TAGS < <(git tag --sort=-version:refname) || true

  if [[ ${#TAGS[@]} -eq 0 ]]; then
    echo "Keine Tags vorhanden."
    return 1
  fi

  while true; do
    echo "Verfügbare Tags:"
    local i=1 tag_name
    for tag_name in "${TAGS[@]}"; do
      echo "  $i) $tag_name"
      ((i++))
    done
    echo "  0) Zurück"

    read -rp "Auswahl: " selection
    echo ""

    if [[ "$selection" == "0" ]]; then
      return 0
    fi

    if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#TAGS[@]} )); then
      selected_tag="${TAGS[selection-1]}"
      break
    else
      echo "Ungültige Auswahl. Bitte erneut versuchen."
    fi
  done

  while true; do
    read -rp "Hotfix-Namen eingeben (nur Buchstaben/Zahlen/._- | 0 zum Abbrechen): " hotfix_name
    if [[ "$hotfix_name" == "0" ]]; then
      echo "Abgebrochen."
      return 0
    fi
    if [[ -z "$hotfix_name" ]]; then
      echo "Eingabe darf nicht leer sein."
      continue
    fi
    if [[ "$hotfix_name" =~ [^a-zA-Z0-9._-] ]]; then
      echo "Ungültiger Name. Erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich."
      continue
    fi
    break
  done

  if [[ $selected_tag != v* ]]; then
    echo "Tag '$selected_tag' entspricht nicht dem erwarteten Format (vX.Y oder vX.Y.Z)."
    return 1
  fi

  version_without_prefix="${selected_tag#v}"
  IFS='.' read -r -a ver_parts <<< "$version_without_prefix"
  if (( ${#ver_parts[@]} < 2 )); then
    echo "Tag '$selected_tag' besitzt nicht genügend Versionsbestandteile."
    return 1
  fi
  if ! [[ ${ver_parts[0]} =~ ^[0-9]+$ && ${ver_parts[1]} =~ ^[0-9]+$ ]]; then
    echo "Tag '$selected_tag' enthält keine numerische Haupt-/Nebenversion."
    return 1
  fi

  patch_part=${ver_parts[2]:-0}
  if ! [[ $patch_part =~ ^[0-9]+$ ]]; then
    echo "Tag '$selected_tag' enthält eine ungültige Patch-Version."
    return 1
  fi

  patch_part=$((patch_part + 1))
  ver_parts[2]=$patch_part

  local branch_prefix="v${ver_parts[0]}${ver_parts[1]}"
  branch_version="${branch_prefix}.$patch_part"
  branch_name="hotfix/${branch_version}-hotfix_${hotfix_name}"

  if git show-ref --verify --quiet "refs/heads/$branch_name"; then
    echo "❌ Fehler: Der Branch '$branch_name' existiert lokal bereits."
    return 1
  fi
  if git ls-remote --heads origin "$branch_name" | grep -q "$branch_name"; then
    echo "❌ Fehler: Der Branch '$branch_name' existiert bereits auf Remote."
    return 1
  fi

  git checkout -b "$branch_name" "$selected_tag"
  git push -u origin "$branch_name"

  echo "✅ Hotfix-Branch '$branch_name' wurde von Tag '$selected_tag' erstellt und gepusht."
  echo "   Basisversion: $branch_version"
}

select_hotfix_branch() {
  local __resultvar=$1
  local selection
  local -a HOTFIX_BRANCHES
  local branch
  local i

  if [[ -z "$__resultvar" ]]; then
    echo "Interner Fehler: Kein Ausgabe-Parameter übergeben."
    return 1
  fi

  git fetch origin --prune >/dev/null 2>&1 || true
  mapfile -t HOTFIX_BRANCHES < <(git branch -r --format='%(refname:lstrip=3)' | grep '^hotfix/') || true

  if [[ ${#HOTFIX_BRANCHES[@]} -eq 0 ]]; then
    echo "Keine Hotfix-Branches gefunden."
    return 1
  fi

  while true; do
    echo "Verfügbare Hotfix-Branches:"
    i=1
    for branch in "${HOTFIX_BRANCHES[@]}"; do
      echo "  $i) $branch"
      ((i++))
    done
    echo "  0) Zurück"

    read -rp "Auswahl: " selection
    echo ""

    if [[ "$selection" == "0" ]]; then
      echo "Abgebrochen."
      return 1
    fi

    if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#HOTFIX_BRANCHES[@]} )); then
      printf -v "$__resultvar" '%s' "${HOTFIX_BRANCHES[selection-1]}"
      return 0
    else
      echo "Ungültige Auswahl. Bitte erneut versuchen."
    fi
  done
}

apply_hotfix_branch_to_target() {
  local HOTFIX_BRANCH="$1"
  local TARGET_BRANCH="$2"
  local CURRENT_BRANCH REMOTE_HOTFIX base_commit
  local -a commit_list
  local applied_count skipped_count commit commit_desc
  local patch_tmp err_tmp status_output

  if [[ -z "$HOTFIX_BRANCH" || -z "$TARGET_BRANCH" ]]; then
    echo "Interner Fehler: Hotfix- oder Ziel-Branch fehlt."
    return 1
  fi

  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

  if ! git diff-index --quiet HEAD --; then
    echo "⚠️ Es gibt uncommittete Änderungen auf $CURRENT_BRANCH. Bitte bereinigen, bevor Hotfixes angewendet werden."
    return 1
  fi

  git fetch origin "$HOTFIX_BRANCH" >/dev/null 2>&1 || true

  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    git checkout "$TARGET_BRANCH"
    git pull origin "$TARGET_BRANCH"
  else
    if ! git ls-remote --heads origin "$TARGET_BRANCH" >/dev/null 2>&1; then
      echo "❌ Ziel-Branch '$TARGET_BRANCH' existiert nicht auf origin."
      return 1
    fi
    git checkout -b "$TARGET_BRANCH" "origin/$TARGET_BRANCH"
  fi

  if ! git diff-index --quiet HEAD --; then
    echo "⚠️ Bitte stelle sicher, dass $TARGET_BRANCH vor dem Anwenden sauber ist."
    return 1
  fi

  REMOTE_HOTFIX="origin/$HOTFIX_BRANCH"
  base_commit=$(git merge-base "$TARGET_BRANCH" "$REMOTE_HOTFIX") || true

  if [[ -z "$base_commit" ]]; then
    echo "❌ Konnte gemeinsamen Stand zwischen $TARGET_BRANCH und $REMOTE_HOTFIX nicht ermitteln."
    return 1
  fi

  mapfile -t commit_list < <(git rev-list --reverse "$base_commit".."$REMOTE_HOTFIX") || true

  if [[ ${#commit_list[@]} -eq 0 ]]; then
    echo "ℹ️ $TARGET_BRANCH enthält bereits alle Hotfix-Commits."
    if [[ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
      git checkout "$CURRENT_BRANCH"
    fi
    return 0
  fi

  echo "Übernehme ${#commit_list[@]} Hotfix-Commit(s) nach $TARGET_BRANCH (ohne Commit) ..."

  applied_count=0
  skipped_count=0

  for commit in "${commit_list[@]}"; do
    commit_desc=$(git show -s --format='%h %s' "$commit")
    echo "➡️  Übertrage $commit_desc"

    patch_tmp=$(mktemp)
    err_tmp=$(mktemp)

    if ! git format-patch -1 --stdout "$commit" > "$patch_tmp"; then
      echo "❌ Konnte Patch für $commit_desc nicht erstellen."
      rm -f "$patch_tmp" "$err_tmp"
      return 1
    fi

    if git apply --check --index --3way "$patch_tmp" >/dev/null 2>"$err_tmp"; then
      if git apply --index --3way "$patch_tmp" >/dev/null 2>>"$err_tmp"; then
        ((applied_count++))
      else
        echo "❌ Fehler beim Anwenden von $commit_desc."
        cat "$err_tmp"
        rm -f "$patch_tmp" "$err_tmp"
        return 1
      fi
    else
      if grep -qi 'already applied' "$err_tmp"; then
        echo "ℹ️  $commit_desc ist bereits in $TARGET_BRANCH enthalten – übersprungen."
        ((skipped_count++))
      else
        echo "❌ Konflikte beim Anwenden von $commit_desc."
        cat "$err_tmp"
        rm -f "$patch_tmp" "$err_tmp"
        echo "   Bitte Konflikte manuell lösen; die Änderungen verbleiben auf $TARGET_BRANCH."
        return 1
      fi
    fi

    rm -f "$patch_tmp" "$err_tmp"
  done

  if (( applied_count > 0 )); then
    echo "✅ Hotfix-Änderungen wurden nach $TARGET_BRANCH übertragen. Es wurde kein Commit erstellt."
    echo "   Bitte Änderungen prüfen, bei Bedarf anpassen und manuell committen/pushen."
  else
    echo "ℹ️ Keine neuen Hotfix-Änderungen für $TARGET_BRANCH erforderlich. ($skipped_count übersprungen)"
  fi

  status_output=$(git status --porcelain)
  if [[ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
    if [[ -z "$status_output" ]]; then
      git checkout "$CURRENT_BRANCH"
    else
      echo "ℹ️ Du befindest dich weiterhin auf $TARGET_BRANCH, um die Änderungen zu prüfen."
      echo "   Kehre nach Abschluss manuell zu $CURRENT_BRANCH zurück."
    fi
  fi
}
apply_hotfix_to_master() {
  local HOTFIX_BRANCH
  if ! select_hotfix_branch HOTFIX_BRANCH; then
    return 0
  fi
  apply_hotfix_branch_to_target "$HOTFIX_BRANCH" "master"
}

apply_hotfix_to_dev() {
  local HOTFIX_BRANCH
  if ! select_hotfix_branch HOTFIX_BRANCH; then
    return 0
  fi
  apply_hotfix_branch_to_target "$HOTFIX_BRANCH" "dev"
}

apply_hotfix_to_features() {
  local HOTFIX_BRANCH
  local -a FEATURE_BRANCHES selection target_branches
  local branch choice i

  if ! select_hotfix_branch HOTFIX_BRANCH; then
    return 0
  fi

  mapfile -t FEATURE_BRANCHES < <(git branch -r --format='%(refname:lstrip=3)' | grep '^feature/') || true

  if [[ ${#FEATURE_BRANCHES[@]} -eq 0 ]]; then
    echo "Keine Feature-Branches gefunden."
    return 0
  fi

  echo "Verfügbare Feature-Branches:"
  i=1
  for branch in "${FEATURE_BRANCHES[@]}"; do
    echo "  $i) $branch"
    ((i++))
  done
  echo "  0) Abbrechen"

  read -rp "Bitte Branch-Auswahl (z.B. 1 3 4 oder 0): " -a selection
  echo ""

  if [[ ${selection[0]} == "0" ]]; then
    echo "Abgebrochen."
    return 0
  fi

  for choice in "${selection[@]}"; do
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#FEATURE_BRANCHES[@]} )); then
      target_branches+=("${FEATURE_BRANCHES[choice-1]}")
    else
      echo "⚠️ Ungültige Auswahl ignoriert: $choice"
    fi
  done

  if [[ ${#target_branches[@]} -eq 0 ]]; then
    echo "Keine gültigen Feature-Branches ausgewählt."
    return 0
  fi

  for branch in "${target_branches[@]}"; do
    echo ""
    echo "➡️  Übernehme Hotfix auf $branch"
    if ! apply_hotfix_branch_to_target "$HOTFIX_BRANCH" "$branch"; then
      echo "❌ Abbruch nach Fehler in $branch."
      return 1
    fi
  done

  echo ""
  echo "✅ Hotfix wurde auf alle ausgewählten Feature-Branches angewendet."
}

create_new_feature() {
  local dev_branch="dev"
  local feature_name feature_branch base_commit

  read -rp "Bitte den Namen des neuen Features eingeben: " feature_name
  if [[ -z "$feature_name" ]]; then
    echo "❌ Fehler: Kein Feature-Name angegeben."
    return 1
  fi

  if [[ "$feature_name" =~ [^a-zA-Z0-9._-] ]]; then
    echo "❌ Fehler: Ungültiger Branch-Name. Erlaubt sind Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich."
    return 1
  fi

  feature_branch="feature/$feature_name"

  if ! git diff-index --quiet HEAD --; then
    echo "⚠️ Es gibt noch uncommittete Änderungen. Bitte committen oder stashen, bevor ein neuer Branch erstellt wird."
    return 1
  fi

  if git show-ref --verify --quiet "refs/heads/$feature_branch"; then
    echo "❌ Fehler: Der Branch '$feature_branch' existiert lokal bereits."
    return 1
  fi

  if git ls-remote --heads origin "$feature_branch" | grep -q "$feature_branch"; then
    echo "❌ Fehler: Der Branch '$feature_branch' existiert bereits auf Remote."
    return 1
  fi

  git checkout "$dev_branch"
  git pull origin "$dev_branch"

  git checkout -b "$feature_branch" "$dev_branch"
  git push -u origin "$feature_branch"

  base_commit=$(git rev-parse --short HEAD)

  echo "✅ Neuer Feature-Branch '$feature_branch' wurde erstellt und auf Remote gepusht."
  echo "   Basis: $dev_branch@$base_commit"
}

merge_feature_into_dev() {
  local DEV_BRANCH="dev"
  local FEATURE_BRANCH branch_name
  local choice i
  local -a BRANCH_ARRAY

  mapfile -t BRANCH_ARRAY < <(git branch -r --format='%(refname:lstrip=3)' | grep '^feature/') || true

  if [[ ${#BRANCH_ARRAY[@]} -eq 0 ]]; then
    echo "Keine Feature-Branches vorhanden."
    return 0
  fi

  while true; do
    echo "Verfügbare Feature-Branches:"
    i=1
    for branch_name in "${BRANCH_ARRAY[@]}"; do
      echo "  $i) $branch_name"
      ((i++))
    done
    echo "  0) Zurück"

    read -rp "Auswahl: " choice
    echo ""

    if [[ "$choice" == "0" ]]; then
      return 0
    fi

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#BRANCH_ARRAY[@]} )); then
      FEATURE_BRANCH="${BRANCH_ARRAY[choice-1]}"
      break
    else
      echo "Ungültige Auswahl. Bitte erneut versuchen."
    fi
  done

  echo "Ausgewählter Feature-Branch: $FEATURE_BRANCH"

  git checkout "$DEV_BRANCH"
  git pull origin "$DEV_BRANCH"

  if ! git show-ref --verify --quiet "refs/heads/$FEATURE_BRANCH"; then
    git checkout -b "$FEATURE_BRANCH" "origin/$FEATURE_BRANCH"
  else
    git checkout "$FEATURE_BRANCH"
    git pull origin "$FEATURE_BRANCH"
  fi

  git checkout "$DEV_BRANCH"
  git merge --no-ff "$FEATURE_BRANCH" -m "Merge $FEATURE_BRANCH into $DEV_BRANCH"

  git push origin "$DEV_BRANCH"

  echo "Feature $FEATURE_BRANCH wurde erfolgreich in $DEV_BRANCH gemerged."
}


sync_readme_to_features() {
  local BASE_BRANCH="dev"
  local MASTER_BRANCH="master"
  local -a FEATURE_BRANCHES TARGET_BRANCHES selection
  local -a ALL_BRANCHES
  local choice branch i
  local readme_path="README.md"

  if [[ ! -f "$readme_path" ]]; then
    echo "❌ README.md nicht gefunden."
    return 1
  fi

  mapfile -t FEATURE_BRANCHES < <(git branch -r --format='%(refname:lstrip=3)' | grep '^feature/') || true
  ALL_BRANCHES=("${FEATURE_BRANCHES[@]}" "master")

  if [[ ${#ALL_BRANCHES[@]} -eq 0 ]]; then
    echo "Keine geeigneten Branches gefunden."
    return 0
  fi

  echo "Verfügbare Branches:"
  i=1
  for branch in "${ALL_BRANCHES[@]}"; do
    echo "  $i) $branch"
    ((i++))
  done
  echo "  0) Abbrechen"

  read -rp "Bitte Branch-Auswahl (z.B. 1 3 4 oder 0): " -a selection
  echo ""

  if [[ ${selection[0]} == "0" ]]; then
    echo "Abgebrochen."
    return 0
  fi

  for choice in "${selection[@]}"; do
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ALL_BRANCHES[@]} )); then
      TARGET_BRANCHES+=("${ALL_BRANCHES[choice-1]}")
    else
      echo "⚠️ Ungültige Auswahl ignoriert: $choice"
    fi
  done

  if [[ ${#TARGET_BRANCHES[@]} -eq 0 ]]; then
    echo "Keine gültigen Branches ausgewählt."
    return 0
  fi

  local CURRENT_BRANCH
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

  git checkout "$BASE_BRANCH"
  git pull origin "$BASE_BRANCH"

  for branch in "${TARGET_BRANCHES[@]}"; do
    echo "\n➡️  Synchronisiere README in $branch"

    if ! git show-ref --verify --quiet "refs/heads/$branch"; then
      git checkout -b "$branch" "origin/$branch"
    else
      git checkout "$branch"
      git pull origin "$branch"
    fi

    git checkout "$BASE_BRANCH" -- "$readme_path"
    git add "$readme_path"
    git commit -m "Sync README from $BASE_BRANCH" || echo "Keine README-Änderungen in $branch"
    git push origin "$branch"

    git checkout "$BASE_BRANCH"
  done

  git checkout "$CURRENT_BRANCH"
  echo "\n✅ README wurde in den ausgewählten Feature-Branches aktualisiert."
}


merge_dev_into_master() {
  local DEV_BRANCH="dev"
  local MASTER_BRANCH="master"

  # Auf master wechseln und aktuell holen
  git checkout "$MASTER_BRANCH"
  git pull origin "$MASTER_BRANCH"

  # Dev aktuell holen
  if ! git show-ref --verify --quiet "refs/heads/$DEV_BRANCH"; then
    git checkout -b "$DEV_BRANCH" "origin/$DEV_BRANCH"
  else
    git checkout "$DEV_BRANCH"
    git pull origin "$DEV_BRANCH"
  fi

  # Merge Dev in Master
  git checkout "$MASTER_BRANCH"
  git merge --no-ff "$DEV_BRANCH" -m "Merge $DEV_BRANCH into $MASTER_BRANCH"

  # Push Master auf Remote
  git push origin "$MASTER_BRANCH"

  echo "Branch $DEV_BRANCH wurde in $MASTER_BRANCH gemerged."
}


push_changes() {
  set -e

  # Aktuellen Branch herausfinden
  local BRANCH
  BRANCH=$(git rev-parse --abbrev-ref HEAD)

  # Branch bestätigen
  read -rp "Aktueller Branch: $BRANCH. Ist das korrekt? (y/n): " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Abgebrochen."
    return 1
  fi

  # Commit-Nachricht
  local COMMIT_MSG
  read -rp "Bitte Commit-Nachricht eingeben (default: 'Update'): " COMMIT_MSG
  COMMIT_MSG=${COMMIT_MSG:-Update}

  # Änderungen stagen und committen
  echo "Änderungen werden gestaged..."
  git add .
  echo "Commit wird erstellt..."
  git commit -m "$COMMIT_MSG" || echo "Nichts zu committen"

  local VERSION_TAG=""
  # Prüfen, ob Branch master ist
  if [[ "$BRANCH" == "master" ]]; then
    # Versionsnummer abfragen (0 bedeutet: kein Tag)
    while true; do
      read -rp "Bitte Versionsnummer für Master-Release Tag eingeben (oder 0 für keinen Tag): " VERSION_TAG
      if [[ -n "$VERSION_TAG" ]]; then
        break
      else
        echo "Eingabe darf nicht leer sein. Bitte eingeben."
      fi
    done
  fi

  # Push Branch
  echo "Push nach origin/$BRANCH..."
  git push -f origin "$BRANCH"

  # Tag setzen und pushen, nur bei master und wenn nicht 0
  if [[ "$BRANCH" == "master" && "$VERSION_TAG" != "0" ]]; then
    git tag -a "$VERSION_TAG" -m "Release $VERSION_TAG"
    git push origin -f "$VERSION_TAG"
    echo "Tag $VERSION_TAG gesetzt und gepusht."
  else
    if [[ "$BRANCH" == "master" && "$VERSION_TAG" == "0" ]]; then
      echo "Kein Tag gesetzt (manuelle Auswahl: 0)."
    fi
  fi

  echo "Push abgeschlossen."
}



docker_release() {
  local ghcr_username="mboehmlaender"
  local repo_name="stackpulse"
  local branch version_tag




  while true; do
    read -rp "Bitte Versionsnummer für das Docker-Image eingeben (z.B. v0.1): " version_tag
    if [[ -n "$version_tag" ]]; then
      break
    fi
    echo "Versionsnummer darf nicht leer sein."
  done

  branch=$(git rev-parse --abbrev-ref HEAD)

  if [[ "$branch" != "master" ]]; then
    echo "Fehler: Du musst auf 'master' sein, um ein Release zu machen."
    return 1
  fi
  
  if [[ -z "$CR_PAT" ]]; then
    echo "CR_PAT (GitHub Token) nicht gesetzt! Bitte export CR_PAT=<token>"
    return 1
  fi

  echo "$CR_PAT" | docker login ghcr.io -u "$ghcr_username" --password-stdin
  docker build -t "ghcr.io/$ghcr_username/$repo_name:$version_tag" .
  docker tag "ghcr.io/$ghcr_username/$repo_name:$version_tag" "ghcr.io/$ghcr_username/$repo_name:latest"

  docker push "ghcr.io/$ghcr_username/$repo_name:$version_tag"
  docker push "ghcr.io/$ghcr_username/$repo_name:latest"

  echo "Docker-Release $version_tag erfolgreich gebaut und zu GHCR gepusht!"
}



sync_frontend_build() {
  local source_dir="$1"
  local target_dir="$2"

  if [[ -z "$source_dir" || -z "$target_dir" ]]; then
    echo "sync_frontend_build benötigt Quell- und Zielverzeichnis."
    return 1
  fi

  if [[ ! -d "$source_dir" ]]; then
    echo "⚠️ Build-Verzeichnis '$source_dir' wurde nicht gefunden."
    return 1
  fi

  mkdir -p "$target_dir"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$source_dir"/ "$target_dir"/
  else
    find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -R "$source_dir"/. "$target_dir"/
  fi

  echo "✅ Frontend-Build nach '$target_dir' synchronisiert."
}

normalize_semver() {
  local version="$1"
  echo "${version#v}" | sed -E 's/[^0-9.].*$//'
}

version_gte() {
  local current required
  local c_major c_minor c_patch r_major r_minor r_patch

  current=$(normalize_semver "$1")
  required=$(normalize_semver "$2")

  IFS='.' read -r c_major c_minor c_patch <<< "$current"
  IFS='.' read -r r_major r_minor r_patch <<< "$required"

  c_major=${c_major:-0}
  c_minor=${c_minor:-0}
  c_patch=${c_patch:-0}
  r_major=${r_major:-0}
  r_minor=${r_minor:-0}
  r_patch=${r_patch:-0}

  if (( c_major > r_major )); then return 0; fi
  if (( c_major < r_major )); then return 1; fi
  if (( c_minor > r_minor )); then return 0; fi
  if (( c_minor < r_minor )); then return 1; fi
  if (( c_patch >= r_patch )); then return 0; fi
  return 1
}

load_nvm_if_available() {
  if command -v nvm >/dev/null 2>&1; then
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi

  command -v nvm >/dev/null 2>&1
}

try_use_project_node() {
  local project_root="$1"
  local required_version="$2"
  local current_version

  current_version=$(node -v 2>/dev/null || true)
  if [[ -n "$current_version" ]] && version_gte "$current_version" "$required_version"; then
    return 0
  fi

  if ! load_nvm_if_available; then
    return 1
  fi

  pushd "$project_root" >/dev/null
  if [[ -f ".nvmrc" ]]; then
    nvm use --silent >/dev/null 2>&1 || true
  fi
  popd >/dev/null

  current_version=$(node -v 2>/dev/null || true)
  if [[ -n "$current_version" ]] && version_gte "$current_version" "$required_version"; then
    echo "ℹ️ Projekt-Node aktiviert: ${current_version}"
    return 0
  fi

  return 1
}

ensure_minimum_node_version() {
  local project_root="$1"
  local min_version="20.19.0"
  local current_version

  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js wurde nicht gefunden. Bitte Node.js >= ${min_version} installieren."
    return 1
  fi

  try_use_project_node "$project_root" "$min_version" || true

  current_version=$(node -v 2>/dev/null || true)
  if [[ -z "$current_version" ]]; then
    echo "❌ Konnte die Node.js-Version nicht ermitteln."
    return 1
  fi

  if ! version_gte "$current_version" "$min_version"; then
    echo "❌ Node.js ${current_version} erkannt. Für StackPulse wird Node.js >= ${min_version} benötigt."
    echo "   Projektlokal (ohne andere Projekte zu ändern):"
    echo "   nvm install ${min_version} && nvm use"
    return 1
  fi
}

ensure_backend_sqlite_binding() {
  if [[ ! -d node_modules/better-sqlite3 ]]; then
    return 0
  fi

  if node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    return 0
  fi

  echo "⚠️ better-sqlite3 ist nicht mit der aktuellen Node-Version kompatibel. Versuche Rebuild ..."
  npm rebuild better-sqlite3

  if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "❌ better-sqlite3 konnte weiterhin nicht geladen werden."
    echo "   Bitte im Ordner 'backend' ausführen: rm -rf node_modules package-lock.json && npm install"
    return 1
  fi

  echo "✅ better-sqlite3 wurde erfolgreich für $(node -v) vorbereitet."
}

start_dev_environment() {
  local back_pid front_pid
  local script_dir project_root

  echo "🚀 Starte StackPulse Dev-Umgebung..."
  script_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  project_root="$(cd -- "$script_dir/.." && pwd)"
  ensure_minimum_node_version "$project_root" || return 1

  pushd "$project_root/backend" >/dev/null
  read -rp "➡️ Backend: npm install ausführen? (y/N) " backend_install_choice
  if [[ "$backend_install_choice" =~ ^([YyJj]|[Yy]es|[Jj]a)$ ]]; then
    npm install
  else
    echo "ℹ️ Backend npm install übersprungen."
  fi
  ensure_backend_sqlite_binding || return 1
  npm run migrate
  npm start &
  back_pid=$!
  popd >/dev/null

  pushd "$project_root/frontend" >/dev/null
  read -rp "➡️ Frontend: npm install ausführen? (y/N) " frontend_install_choice
  if [[ "$frontend_install_choice" =~ ^([YyJj]|[Yy]es|[Jj]a)$ ]]; then
    npm install
  else
    echo "ℹ️ Frontend npm install übersprungen."
  fi
  npm run build
  sync_frontend_build "dist" "../backend/public"
  npm run dev -- --host &
  front_pid=$!
  popd >/dev/null

  echo ""
  echo "✅ StackPulse läuft lokal:"
  echo "Frontend (Vite Dev): http://localhost:5173"
  echo "Backend API:      http://localhost:4001"
  echo "Die gebaute Oberfläche liegt unter backend/public"
  echo "Beenden mit STRG+C"

  wait "$back_pid" "$front_pid"
}

start_docker_compose() {
  echo "🔄 Starte lokale Docker-Umgebung..."
  docker compose -f docker-compose.dev.yml up --build --force-recreate
}

manage_stash() {
  local current_branch action user_input stash_name choice selected_stash
  local -A stash_map
  local -a stash_list
  local i line stash_ref stash_msg

  current_branch=$(git rev-parse --abbrev-ref HEAD)

  echo "Aktueller Branch: $current_branch"
  echo "Was möchtest du tun?"
  echo "1) Neuen Stash anlegen"
  echo "2) Vorhandenen Stash laden (apply)"
  echo "3) Vorhandenen Stash löschen"
  echo "4) Stash anwenden und löschen (pop)"
  echo "0) Zurück"
  read -rp "Auswahl: " action

  case $action in
    0)
      return 0
      ;;
    1)
      read -rp "Gib einen Namen für den Stash ein: " user_input
      stash_name="$current_branch - $user_input"

      if git stash list | grep -q "$stash_name"; then
        while IFS= read -r line; do
          stash_ref=$(echo "$line" | awk -F: '{print $1}')
          echo "Lösche vorhandenen Stash: $stash_ref"
          git stash drop "$stash_ref"
        done < <(git stash list | grep "$stash_name")
      fi

      git stash push -u -m "$stash_name"
      echo "Stash '$stash_name' wurde angelegt."
      ;;

    2|3|4)
      local action_text
      case $action in
        2) action_text="laden" ;;
        3) action_text="löschen" ;;
        4) action_text="anwenden & löschen" ;;
      esac

      echo "Liste aller Stashes für Branch '$current_branch':"
      mapfile -t stash_list < <(git stash list | grep "$current_branch") || true

      if [[ ${#stash_list[@]} -eq 0 ]]; then
        echo "Keine Stashes für diesen Branch vorhanden."
        return 0
      fi

      i=1
      for line in "${stash_list[@]}"; do
        stash_ref=$(echo "$line" | awk -F: '{print $1}')
        stash_msg=$(echo "$line" | cut -d':' -f3- | sed 's/^ //')
        echo "  $i) $stash_ref -> $stash_msg"
        stash_map[$i]=$stash_ref
        ((i++))
      done
      echo "  0) Zurück"

      read -rp "Wähle einen Stash zum ${action_text} (Nummer): " choice
      if [[ "$choice" == "0" ]]; then
        return 0
      fi
      if [[ -z "${stash_map[$choice]}" ]]; then
        echo "Ungültige Auswahl!"
        return 1
      fi

      selected_stash=${stash_map[$choice]}

      case $action in
        2)
          echo "Wende Stash an: $selected_stash"
          git stash apply "$selected_stash"
          ;;
        3)
          echo "Lösche Stash: $selected_stash"
          git stash drop "$selected_stash"
          ;;
        4)
          echo "Wende Stash an und lösche ihn: $selected_stash"
          git stash pop "$selected_stash"
          ;;
      esac
      ;;

    *)
      echo "Ungültige Auswahl!"
      return 1
      ;;
  esac
}


branch_management_menu() {
  local selection
  while true; do
    echo ""
    cat <<'MENU'
Branch-Verwaltung:

  1) Branch löschen (lokal/remote)
  2) Branch-Listen aktualisieren
  0) Zurück
MENU
    read -rp "Auswahl: " selection
    echo ""
    case $selection in
      1)
        delete_branch
        pause_for_menu
        ;;
      2)
        update_branch_lists
        pause_for_menu
        ;;
      0)
        break
        ;;
      *)
        echo "❌ Ungültige Auswahl."
        ;;
    esac
  done
}

delete_branch() {
  local -a local_branches remote_branches all_branches
  local -A has_local has_remote branch_map
  local current_branch branch label selection selected_branch delete_choice
  local i=1

  current_branch=$(git rev-parse --abbrev-ref HEAD)

  mapfile -t local_branches < <(git branch --format='%(refname:short)')
  mapfile -t remote_branches < <(git branch -r | grep -v 'HEAD' | sed 's|^[[:space:]]*origin/||')
  mapfile -t all_branches < <(printf "%s\n" "${local_branches[@]}" "${remote_branches[@]}" | sed '/^$/d' | sort -u)

  for branch in "${local_branches[@]}"; do
    [[ -n "$branch" ]] && has_local["$branch"]=1
  done
  for branch in "${remote_branches[@]}"; do
    [[ -n "$branch" ]] && has_remote["$branch"]=1
  done

  if [[ ${#all_branches[@]} -eq 0 ]]; then
    echo "Keine Branches zum Löschen gefunden."
    return 1
  fi

  echo "Verfügbare Branches zum Löschen:"
  for branch in "${all_branches[@]}"; do
    label=""
    if [[ -n "${has_local[$branch]}" && -n "${has_remote[$branch]}" ]]; then
      label="(lokal & remote)"
    elif [[ -n "${has_local[$branch]}" ]]; then
      label="(nur lokal)"
    else
      label="(nur remote)"
    fi

    printf "  %d) %s %s\n" "$i" "$branch" "$label"
    branch_map[$i]=$branch
    ((i++))
  done
  echo "  0) Zurück"

  read -rp "Wähle einen Branch (Nummer): " selection
  if [[ "$selection" == "0" ]]; then
    echo "Abgebrochen."
    return 0
  fi
  if [[ -z "${branch_map[$selection]}" ]]; then
    echo "Ungültige Auswahl."
    return 1
  fi

  selected_branch=${branch_map[$selection]}

  if [[ "$selected_branch" == "$current_branch" && -n "${has_local[$selected_branch]}" ]]; then
    echo "Der aktuell ausgecheckte Branch '$selected_branch' kann nicht gelöscht werden."
    return 1
  fi

  if [[ -n "${has_local[$selected_branch]}" && -n "${has_remote[$selected_branch]}" ]]; then
    echo ""
    echo "Branch '$selected_branch' existiert lokal und remote."
    echo "  1) Nur lokal löschen"
    echo "  2) Nur remote löschen"
    echo "  3) Lokal und remote löschen"
    read -rp "Auswahl: " delete_choice
    echo ""
    case $delete_choice in
      1)
        delete_choice="local"
        ;;
      2)
        delete_choice="remote"
        ;;
      3)
        delete_choice="both"
        ;;
      *)
        echo "Ungültige Auswahl."
        return 1
        ;;
    esac
  elif [[ -n "${has_local[$selected_branch]}" ]]; then
    delete_choice="local"
  else
    delete_choice="remote"
  fi

  if [[ "$delete_choice" == "local" || "$delete_choice" == "both" ]]; then
    read -rp "Lokalen Branch '$selected_branch' wirklich löschen? (j/N): " confirmation
    if [[ "$confirmation" =~ ^[JjYy]$ ]]; then
      if git branch -D "$selected_branch"; then
        echo "Lokaler Branch '$selected_branch' wurde gelöscht."
      else
        echo "Fehler beim Löschen des lokalen Branches '$selected_branch'."
        return 1
      fi
    else
      echo "Löschen des lokalen Branches abgebrochen."
      [[ "$delete_choice" == "local" ]] && return 0
    fi
  fi

  if [[ "$delete_choice" == "remote" || "$delete_choice" == "both" ]]; then
    read -rp "Remote-Branch '$selected_branch' auf origin wirklich löschen? (j/N): " confirmation
    if [[ "$confirmation" =~ ^[JjYy]$ ]]; then
      if git push origin --delete "$selected_branch"; then
        echo "Remote-Branch 'origin/$selected_branch' wurde gelöscht."
      else
        echo "Fehler beim Löschen des Remote-Branches '$selected_branch'."
        return 1
      fi
    else
      echo "Löschen des Remote-Branches abgebrochen."
      return 0
    fi
  fi

  return 0
}

update_branch_lists() {
  echo "Aktualisiere Branch-Listen (git fetch origin --prune)..."
  if git fetch origin --prune; then
    echo "Branch-Listen wurden aktualisiert."
  else
    echo "Fehler beim Aktualisieren der Branch-Listen."
    return 1
  fi
}

switch_branch() {
  local -a unversioned_files=("devscripts/*")
  local file
  local local_branches remote_branches all_branches master_branch dev_branch feature_branches hotfix_branches other_branches
  local -a sorted_branches
  local i=1 choice selected_branch
  declare -A branch_map

  for file in "${unversioned_files[@]}"; do
    if [[ -f "$file" ]]; then
      mkdir -p /tmp/git_safe_backup
      cp "$file" "/tmp/git_safe_backup/$(basename "$file")"
    fi
  done
  local_branches=$(git branch | sed 's/* //' | sed 's/^[[:space:]]*//')
  remote_branches=$(git branch -r | grep -v 'HEAD' | sed 's|^[[:space:]]*origin/||' | sed 's/^[[:space:]]*//')
  all_branches=$(printf "%s\n%s\n" "$local_branches" "$remote_branches" | sort -u)

  master_branch=$(echo "$all_branches" | grep -x 'master' || true)
  dev_branch=$(echo "$all_branches" | grep -x 'dev' || true)
  feature_branches=$(echo "$all_branches" | grep '^feature/' | sort || true)
  hotfix_branches=$(echo "$all_branches" | grep '^hotfix/' | sort || true)
  other_branches=$(echo "$all_branches" | grep -Ev '^(master|dev|feature/|hotfix/)' | sort || true)

  [[ -n "$master_branch" ]] && sorted_branches+=("$master_branch")
  [[ -n "$dev_branch" ]] && sorted_branches+=("$dev_branch")
  if [[ -n "$feature_branches" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && sorted_branches+=("$line")
    done <<< "$feature_branches"
  fi
  if [[ -n "$hotfix_branches" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && sorted_branches+=("$line")
    done <<< "$hotfix_branches"
  fi
  if [[ -n "$other_branches" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && sorted_branches+=("$line")
    done <<< "$other_branches"
  fi

  if [[ ${#sorted_branches[@]} -eq 0 ]]; then
    echo "Keine Branches gefunden."
    return 1
  fi

  echo "Verfügbare Branches:"
  for line in "${sorted_branches[@]}"; do
    echo "  $i) $line"
    branch_map[$i]=$line
    ((i++))
  done
  echo "  0) Zurück"

  read -rp "Wähle einen Branch (Nummer): " choice
  if [[ "$choice" == "0" ]]; then
    rm -rf /tmp/git_safe_backup
    echo "Abgebrochen."
    return 0
  fi
  if [[ -z "${branch_map[$choice]}" ]]; then
    echo "Ungültige Auswahl!"
    rm -rf /tmp/git_safe_backup
    return 1
  fi

  selected_branch=${branch_map[$choice]}
  echo "Wechsle zu Branch: $selected_branch"

  git fetch origin

  if git show-ref --verify --quiet "refs/heads/$selected_branch"; then
    git checkout "$selected_branch"
  else
    git checkout -b "$selected_branch" "origin/$selected_branch"
  fi

  git reset --hard "origin/$selected_branch"
  git clean -fd

  for file in "${unversioned_files[@]}"; do
    if [[ -f "/tmp/git_safe_backup/$(basename "$file")" ]]; then
      mkdir -p "$(dirname "$file")"
      mv "/tmp/git_safe_backup/$(basename "$file")" "$file"
    fi
  done
  rm -rf /tmp/git_safe_backup

  echo "Branch '$selected_branch' ist nun aktiv. Arbeitsverzeichnis entspricht exakt dem Remote-Stand."
  echo "Gesicherte Dateien wurden wiederhergestellt."
}

main() {
  local selection
  while true; do
    echo ""
    show_menu
    read -rp "Auswahl: " selection
    echo ""
    case $selection in
      1)
        create_new_feature
        pause_for_menu
        ;;
      2)
        merge_commit_menu
        ;;
      3)
        dev_environments_menu
        ;;
      4)
        hotfix_menu
        ;;
      5)
        branch_management_menu
        ;;
      6)
        switch_branch
        pause_for_menu
        ;;
      0)
        echo "Auf Wiedersehen!"
        exit 0
        ;;
      *)
        echo "❌ Ungültige Auswahl."
        ;;
    esac
  done
}

main "$@"
