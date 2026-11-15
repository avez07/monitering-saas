//go:build linux

package cli

import (
	"fmt"
	"os"
	"syscall"

	"github.com/yuktiops/agent/internal/config"
)

type fileFacts struct {
	uid, gid uint32
	mode     os.FileMode
}

func facts(path string) (fileFacts, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileFacts{}, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileFacts{}, fmt.Errorf("no owner information for %s", path)
	}
	return fileFacts{uid: st.Uid, gid: st.Gid, mode: info.Mode().Perm()}, nil
}

// readableBy says whether the service account (uid, gid) could read a file with these facts.
func (f fileFacts) readableBy(uid, gid uint32) bool {
	switch {
	case uid == f.uid:
		return f.mode&0o400 != 0
	case gid == f.gid:
		return f.mode&0o040 != 0
	}
	return f.mode&0o004 != 0
}

func (f fileFacts) searchableBy(uid, gid uint32) bool {
	switch {
	case uid == f.uid:
		return f.mode&0o100 != 0
	case gid == f.gid:
		return f.mode&0o010 != 0
	}
	return f.mode&0o001 != 0
}

func (f fileFacts) writableBy(uid, gid uint32) bool {
	switch {
	case uid == f.uid:
		return f.mode&0o200 != 0
	case gid == f.gid:
		return f.mode&0o020 != 0
	}
	return f.mode&0o002 != 0
}

// checkFiles verifies that the service user can read its credential and write its state, and
// that the credential is not readable by everyone.
func (d *Doctor) checkFiles() []Result {
	const name = "File permissions"
	uid, gid, haveUser := config.ServiceIDs()
	var problems, warnings []string
	var fix string

	cred, err := facts(d.Paths.CredentialFile())
	switch {
	case err == nil:
		if cred.mode&0o007 != 0 {
			warnings = append(warnings, fmt.Sprintf("the credential file can be read by every user on this server (mode %o)", cred.mode))
			fix = fmt.Sprintf("sudo chown root:%s %s && sudo chmod 640 %s", config.ServiceUser, d.Paths.CredentialFile(), d.Paths.CredentialFile())
		}
		if haveUser && !cred.readableBy(uint32(uid), uint32(gid)) {
			problems = append(problems, fmt.Sprintf("the service user %q cannot read %s", config.ServiceUser, d.Paths.CredentialFile()))
			fix = fmt.Sprintf("sudo chown root:%s %s && sudo chmod 640 %s", config.ServiceUser, d.Paths.CredentialFile(), d.Paths.CredentialFile())
		}
		if dir, err := facts(d.Paths.ConfigDir); err == nil && haveUser {
			if !dir.searchableBy(uint32(uid), uint32(gid)) {
				problems = append(problems, fmt.Sprintf("the service user %q cannot open %s", config.ServiceUser, d.Paths.ConfigDir))
				fix = fmt.Sprintf("sudo chown root:%s %s && sudo chmod 750 %s", config.ServiceUser, d.Paths.ConfigDir, d.Paths.ConfigDir)
			}
		}
	case os.IsPermission(err):
		return []Result{{Name: name, Status: StatusWarn, Code: CodeDiskPermission,
			Detail: "this user cannot look inside " + d.Paths.ConfigDir,
			Fix:    "Run doctor with sudo so it can check everything: sudo yuktiops-agent doctor"}}
	}

	if dir, err := facts(d.Paths.StateDir); err == nil {
		if haveUser && !dir.writableBy(uint32(uid), uint32(gid)) {
			problems = append(problems, fmt.Sprintf("the service user %q cannot write to %s (the offline buffer and status are kept there)", config.ServiceUser, d.Paths.StateDir))
			fix = fmt.Sprintf("sudo chown -R %s:%s %s", config.ServiceUser, config.ServiceUser, d.Paths.StateDir)
		}
	}

	switch {
	case len(problems) > 0:
		return []Result{{Name: name, Status: StatusFail, Code: CodeDiskPermission, Detail: joinSentences(problems), Fix: fix}}
	case len(warnings) > 0:
		return []Result{{Name: name, Status: StatusWarn, Code: CodeDiskPermission, Detail: joinSentences(warnings), Fix: fix}}
	}
	return []Result{ok(name, "the credential is private and the service user can use its files")}
}

func joinSentences(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "; "
		}
		out += p
	}
	return out
}
