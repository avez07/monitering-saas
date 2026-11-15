//go:build linux

package collect

import "syscall"

// statfs asks the kernel for the size and free space of the filesystem at path. It only reads.
func statfs(path string) (fsUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return fsUsage{}, err
	}
	size := uint64(st.Frsize)
	if size == 0 {
		size = uint64(st.Bsize)
	}
	return fsUsage{
		BlockSize: size,
		Blocks:    uint64(st.Blocks),
		Bfree:     uint64(st.Bfree),
		Bavail:    uint64(st.Bavail),
	}, nil
}
