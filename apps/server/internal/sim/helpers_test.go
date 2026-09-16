package sim

import (
	"bytes"
	"io"
)

func readerOf(b []byte) io.Reader { return bytes.NewReader(b) }
