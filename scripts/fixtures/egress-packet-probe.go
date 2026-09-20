//go:build linux

// Disposable-container probe. It sends one labeled UDP frame only to the
// receiver created by smoke-egress-capabilities.js, using its own source MAC/IP.
package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

const port = 19085

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("mode required"))
	}
	switch os.Args[1] {
	case "listen":
		c, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
		if err != nil {
			fail(err)
		}
		defer c.Close()
		fmt.Println("READY")
		c.SetReadDeadline(time.Now().Add(120 * time.Second))
		b := make([]byte, 256)
		for {
			n, _, err := c.ReadFromUDP(b)
			if err != nil {
				fail(err)
			}
			fmt.Println(string(b[:n]))
		}
	case "socket-denied":
		fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, 0x0008)
		if err == nil {
			syscall.Close(fd)
			fail(errors.New("AF_PACKET unexpectedly permitted"))
		}
		if !errors.Is(err, syscall.EPERM) {
			fail(err)
		}
		fmt.Println("AF_PACKET_DENIED")
	case "normal-blocked":
		if len(os.Args) != 4 {
			fail(errors.New("receiver and marker required"))
		}
		c, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP(os.Args[2]), Port: port})
		if err != nil {
			fail(err)
		}
		defer c.Close()
		_, err = c.Write([]byte(os.Args[3]))
		if !errors.Is(err, syscall.EPERM) {
			fail(fmt.Errorf("OUTPUT drop did not reject UDP: %v", err))
		}
		fmt.Println("UDP_OUTPUT_BLOCKED")
	case "raw":
		if len(os.Args) != 5 {
			fail(errors.New("receiver IP/MAC and marker required"))
		}
		dst := net.ParseIP(os.Args[2]).To4()
		mac, err := net.ParseMAC(os.Args[3])
		if err != nil || len(mac) != 6 || dst == nil || !dst.IsPrivate() {
			fail(errors.New("invalid disposable receiver"))
		}
		iface, err := net.InterfaceByName("eth0")
		if err != nil {
			fail(err)
		}
		addresses, err := iface.Addrs()
		if err != nil {
			fail(err)
		}
		var src net.IP
		for _, a := range addresses {
			ip, _, _ := net.ParseCIDR(a.String())
			if ip.To4() != nil {
				src = ip.To4()
				break
			}
		}
		if src == nil || len(iface.HardwareAddr) != 6 {
			fail(errors.New("missing own interface identity"))
		}
		payload := []byte(os.Args[4])
		if len(payload) > 128 {
			fail(errors.New("marker too long"))
		}
		frame := make([]byte, 14+20+8+len(payload))
		copy(frame[:6], mac)
		copy(frame[6:12], iface.HardwareAddr)
		binary.BigEndian.PutUint16(frame[12:14], 0x0800)
		ip := frame[14:34]
		ip[0] = 0x45
		ip[8] = 64
		ip[9] = 17
		binary.BigEndian.PutUint16(ip[2:4], uint16(20+8+len(payload)))
		copy(ip[12:16], src)
		copy(ip[16:20], dst)
		var sum uint32
		for i := 0; i < 20; i += 2 {
			sum += uint32(binary.BigEndian.Uint16(ip[i : i+2]))
		}
		for sum > 0xffff {
			sum = (sum & 0xffff) + (sum >> 16)
		}
		binary.BigEndian.PutUint16(ip[10:12], ^uint16(sum))
		udp := frame[34:42]
		binary.BigEndian.PutUint16(udp[:2], port+1)
		binary.BigEndian.PutUint16(udp[2:4], port)
		binary.BigEndian.PutUint16(udp[4:6], uint16(8+len(payload)))
		copy(frame[42:], payload) // IPv4 UDP permits a zero checksum.
		fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, 0x0008)
		if err != nil {
			fail(err)
		}
		defer syscall.Close(fd)
		address := &syscall.SockaddrLinklayer{Ifindex: iface.Index, Protocol: 0x0008, Halen: 6}
		copy(address.Addr[:], mac)
		if err := syscall.Sendto(fd, frame, 0, address); err != nil {
			fail(err)
		}
		fmt.Println("ONE_OWN_SOURCE_FRAME_SENT")
	default:
		fail(errors.New("unknown mode"))
	}
}
