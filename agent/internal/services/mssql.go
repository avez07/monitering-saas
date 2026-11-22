package services

import (
	"encoding/binary"
	"io"
	"net"
)

// TDS packet types.
const (
	tdsPrelogin = 0x12
	tdsReply    = 0x04
)

// preloginPacket is a minimal TDS PRELOGIN request: VERSION and ENCRYPTION options. It carries
// no credentials; any TDS reply means SQL Server is running.
func preloginPacket() []byte {
	// Option tokens: type(1) offset(2) length(2), then the terminator 0xFF. Offsets are relative
	// to the start of the payload.
	const tokens = 5 + 5 + 1
	payload := []byte{
		0x00, 0, tokens, 0, 6, // VERSION: 6 bytes at offset 11
		0x01, 0, tokens + 6, 0, 1, // ENCRYPTION: 1 byte at offset 17
		0xff,
		0, 0, 0, 0, 0, 0, // version 0.0.0.0, sub-build 0
		0x02, // ENCRYPT_NOT_SUP
	}
	header := make([]byte, 8)
	header[0] = tdsPrelogin
	header[1] = 0x01 // status: end of message
	binary.BigEndian.PutUint16(header[2:], uint16(len(header)+len(payload)))
	header[6] = 1 // packet id
	return append(header, payload...)
}

func probeMSSQL(conn net.Conn) (string, bool) {
	if _, err := conn.Write(preloginPacket()); err != nil {
		return "no answer", false
	}
	head := make([]byte, 8)
	if _, err := io.ReadFull(conn, head); err != nil {
		return "no answer", false
	}
	if head[0] == tdsReply {
		return "responding", true
	}
	return "unexpected reply", false
}
