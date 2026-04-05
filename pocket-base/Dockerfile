FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o pocket-base ./main.go

FROM alpine:3.20

WORKDIR /pb
RUN adduser -D -u 10001 appuser && mkdir -p /pb/pb_data && chown -R appuser:appuser /pb
COPY --from=builder /app/pocket-base /usr/local/bin/pocket-base

USER appuser
EXPOSE 8080
ENV PB_DATA_DIR=/pb/pb_data
ENV JWT_SECRET=change-me

CMD ["pocket-base"]
